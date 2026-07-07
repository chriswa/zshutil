#!/usr/bin/env python3
"""Watch Claude Code transcript(s) and read each new agent message aloud.

For every new assistant text message that appears, this:
  1. Gathers the last few conversational turns (user + assistant) for context.
  2. Calls the Anthropic Messages API (haiku, via the Keychain OAuth token) to
     compress the *latest* assistant message into a very short spoken update,
     using the earlier turns only as context.
  3. Reads that short update aloud via `cartesia-read`, in a voice chosen
     deterministically from the session id (so each session has its own voice).

Playback is strictly sequential: we block until one update finishes being read
before processing the next. Files are opened only transiently (state is a few
numbers per session held in RAM), so it can run for weeks without leaking
handles.

Usage:
    transcript-reader.py /path/to/<session-id>.jsonl   # one session
    transcript-reader.py --all                          # every session, live
"""

import argparse
import glob
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

# --------------------------------------------------------------------------
# Tunables
# --------------------------------------------------------------------------

# When True: summarize + read every assistant message already in the file, then
# tail. When False: start at the current end and only handle new messages.
# (History is always parsed for *context* regardless — this flag only controls
# which messages get spoken.)
READ_BACKLOG = False

# How many recent spoken summaries to remember per session — fed to the
# summarizer so it doesn't repeat itself from one turn to the next. (The
# conversation context sent to haiku is just the current turn; see handle_change.)
SPOKEN_HISTORY = 10

# How long to sleep between polls when the file hasn't grown.
POLL_INTERVAL_S = 0.5

# A file that appears *after* startup (a newly-created or forked session) is
# baselined like the startup files — its existing content is treated as backlog
# and skipped; only what's appended afterward is spoken. We wait for its size to
# stop changing for SETTLE_SECONDS before locking the baseline, so a slow or
# whole-cloth fork-copy is fully captured rather than read as "new activity".
# MAX_SETTLE_WAIT caps the wait so a continuously-active file still baselines.
SETTLE_SECONDS = 2.5
MAX_SETTLE_WAIT = 20.0

# Summarizer model + per-call timeout. We call the Anthropic Messages API
# directly (via the Claude Code OAuth token in the macOS Keychain) rather than
# shelling out to `claude -p`, which carries ~8s of CLI/MCP startup per call.
SUMMARY_MODEL = "claude-haiku-4-5-20251001"
API_URL = "https://api.anthropic.com/v1/messages"
API_TIMEOUT_S = 30
KEYCHAIN_SERVICE = "Claude Code-credentials"

CARTESIA_READ = "cartesia-read"

# spaceterm's ingest socket. We push fire-and-forget "speaking" events here so
# spaceterm can later show which surface is talking. Same socket + newline-JSON
# protocol its own plugin tools use (~/.spaceterm/hooks.sock).
SPACETERM_HOOKS_SOCKET = os.path.join(
    os.environ.get("SPACETERM_HOME") or os.path.expanduser("~/.spaceterm"),
    "hooks.sock")

# Glob matching every Claude Code transcript across all project dirs. Re-globbed
# each poll, so new session files and new project dirs are picked up for free.
TRANSCRIPTS_GLOB = os.path.expanduser("~/.claude/projects/*/*.jsonl")

# English preset voices (name -> id), pulled from GET /voices. The voice is
# chosen deterministically from the session id (see pick_voice), so a given
# session always sounds like the same speaker while different sessions differ.
ENGLISH_VOICES = [
    ("Asher - Podcaster", "00967b2f-88a6-4a31-8153-110a92134b9f"),
    ("Callie - Encourager", "00a77add-48d5-4ef6-8157-71e5437b282d"),
    ("Maeve - Steady Host", "02a924f6-bb49-4177-8fbb-52238c5056d6"),
    ("Calypso - ASMR Lady", "03496517-369a-4db1-8236-3d3ae459ddf7"),
    ("Amelia - Instructor", "043cfc81-d69f-4bee-ae1e-7862cb358650"),
    ("Samantha - Angry Support Leader", "04bfd756-4fd4-42c2-9ccf-37f647c5bf54"),
    ("Anele - Bright Presenter", "072d954b-8379-4b6b-816a-bb0cd38725f8"),
    ("Carson - Angry Friendly Support", "0b32066b-2bcc-44b9-89ab-0223a09d1606"),
    ("Doris - Friend", "0c8ed86e-6c64-40f0-b252-b773911de6bb"),
    ("Morgan - Executive Expert", "0ee8beaa-db49-4024-940d-c7ea09b590b3"),
    ("Rachel - Polished Presence", "10bd4af4-825b-49b8-b8bd-0ca11865536e"),
    ("David - Surprised Greeter", "10d17ae0-8f64-472a-be00-f00a98c729e0"),
    ("Ruth - Manager", "11af83e2-23eb-452f-956e-7fee218ccb5c"),
    ("Cindy - Receptionist", "1242fb95-7ddd-44ac-8a05-9e8a22a6137d"),
    ("Devansh - Warm Support Agent", "1259b7e3-cb8a-43df-9446-30971a46b8b0"),
    ("Madison - Best Friend", "134838f5-ce7e-4876-ac32-6367b99daf83"),
    ("Barry - Helper", "13524ffb-a918-499a-ae97-c98c7c4408c4"),
    ("Tim - Pal", "146485fd-8736-41c7-88a8-7cdd0da34d84"),
    ("Alec - Spirited Salesman", "17044048-bfab-44b2-9532-9c1b65e9c217"),
    ("Esther - Gracious Helper", "1a0c6bb2-bc1b-476e-8d45-56a66300362b"),
    ("Saira - Organized Coordinator", "1e9b9b3d-d2ce-4cac-9d05-bc36a63fa28e"),
    ("Conor - Decisive Agent", "1ec736fa-db96-4eea-9299-235ce2cb7a0e"),
    ("Carlo - Roman Guide", "1fc31370-81b1-4588-9c1a-f93793c6e01d"),
    ("Riley - Chill Friend", "21b81c14-f85b-436d-aff5-43f2e788ecf8"),
    ("Oscar - Clear Specialist", "22df7143-7987-4e15-a720-d65c69a443b3"),
    ("Dallas - Fireside Friend", "23e9e50a-4ea2-447b-b589-df90dbb848a2"),
    ("Elizabeth - Manager", "248be419-c632-4f23-adf1-5324ed7dbf1d"),
    ("Loretta - Still Comfort", "25bf938a-025c-4dd0-906f-8cf8be2e26e9"),
    ("Jessica - Clear Communicator", "25d7abcb-4d6d-4aca-adce-8a1c85620c8b"),
    ("Zanele - Vibrant Advocate", "263b9cc0-0d99-44e7-ae92-3d4ad5d2ad18"),
    ("Madison - Sad Best Friend", "27c12970-3efb-4f39-a78a-2fbb7bddc941"),
    ("Jane - Digital Guide", "2a17e905-8f14-4db7-9b9d-9223a8e3f278"),
    ("Wes - Customer Companion", "2a4d065a-ac91-4203-a015-eb3fc3ee3365"),
    ("Lucy - Capable Coordinator", "2f251ac3-89a9-4a77-a452-704b474ccd01"),
    ("Madison - Scared Best Friend", "30236d07-62d0-4c63-abf7-df46aa45e473"),
    ("Daisy - Reading Girl", "32b3f3c5-7171-46aa-abe7-b598964aa793"),
    ("Joey - Neighborhood Guy", "34575e71-908f-4ab6-ab54-b08c95d6597d"),
    ("Griffin - Excited Narrator", "34d923aa-c3b5-4f21-aac7-2c1f12730d4b"),
    ("Kendra - Smooth Communicator", "358e650d-ac0b-4a74-b14f-aca3daa40d79"),
    ("Sheldon - Help Desk Man", "39b376fc-488e-4d0c-8b37-e00b72059fdd"),
    ("Simi - Support Specialist", "3b554273-4299-48b9-9aaf-eefd438e3941"),
    ("Benedict - Measured Mediator", "3c0f09d6-e0d7-499c-a594-70c5b7b93048"),
    ("Luke - Happy Broadway Voice", "3d79b1fd-daaa-439c-bff3-903dc18e7684"),
    ("Cole - Clear Communicator", "3e39e9a5-585c-4f5f-bac6-5e4905c51095"),
    ("Travis - How To Guide", "40104aff-a015-4da1-9912-af950fbec99e"),
    ("Clementine - Hospitable Host", "4111bc29-d7ff-4a15-90db-819f7b4f7706"),
    ("Clarence - Newsman", "41534e16-2966-4c6b-9670-111411def906"),
    ("Liam - Guy Next Door", "41f3c367-e0a8-4a85-89e0-c27bae9c9b6d"),
    ("Levi - Steady Spokesman", "4703c250-66e4-4682-a223-0a60acafcfc0"),
    ("Cooper - Friendly Mate", "49743b08-0f5d-4741-839c-b12933853780"),
    ("Johan - Deep Consultant", "4b31d090-8d2d-4bcd-8a32-1c135301e26e"),
    ("George - Composed Consultant", "4bc3cb8c-adb9-4bb8-b5d5-cbbef950b991"),
    ("Carson - Friendly Support", "4df027cb-2920-4a1f-8c34-f21529d5c3fe"),
    ("Casper - Gentle Narrator", "4f7f1324-1853-48a6-b294-4e78e8036a83"),
    ("Barry 2.0 - Helper", "4fb26a05-57de-4d21-855a-f51adae44f38"),
    ("Reed - Polished Professional", "533b2990-5b82-45a4-b9f2-367776972ca6"),
    ("Camille - Friendly Expert", "55deba52-bc73-4481-ab69-9c8831c8a7c3"),
    ("Mark - Promotion Lead", "5619d38c-cf51-4d8e-9575-48f61a280413"),
    ("Ray - Conversationalist", "565510e8-6b45-45de-8758-13588fbaec73"),
    ("Lexi - Fun Friend", "56b87df1-594d-4135-992c-1112bb504c59"),
    ("Rebecca - Counselor", "57b6bf63-c7a1-4ffc-8e10-23bf45152dd6"),
    ("Lori - Cheerleader", "57c63422-d911-4666-815b-0c332e4d7d6a"),
    ("Janet - Sunny Speaker", "58fbaf73-d7de-4e82-a6b3-118180e7057c"),
    ("Madison - Disgusted Best Friend", "5993c2c9-5d59-403e-b459-946c8b302086"),
    ("Imogen - Polished Guide", "5a93ae96-9e3e-4b9d-8575-5f62b7de6d0f"),
    ("Jo - Go to Gal", "5abd2130-146a-41b1-bcdb-974ea8e19f56"),
    ("Mary - Nurse", "5c42302c-194b-4d0c-ba1a-8cb485c84ab9"),
    ("Alfie - Composed Advisor", "5e7d492a-5502-482e-b315-ebf587427806"),
    ("Ronald - Thinker", "5ee9feff-1265-424a-9d7f-8e4d431a12c7"),
    ("Willow - Approachable Ally", "5f621418-ab01-4bf4-9a9d-73d66032234e"),
    ("Wyatt - Dependable Dispatcher", "5fc5c797-12c5-4f2b-ac9b-d4e53c08098f"),
    ("Brenda - Host", "607167f6-9bf2-473c-accc-ac7b3b66b30b"),
    ("Luke - Angry Broadway Voice", "61001bc6-9064-40a4-b8b2-29178e0fa558"),
    ("Gemma - Decisive Agent", "62ae83ad-4f6a-430b-af41-a9bede9286ca"),
    ("Corey - Supportive Buddy", "630ed21c-2c5c-41cf-9d82-10a7fd668370"),
    ("Luke - Scared Broadway Voice", "63426c82-a0c9-4f23-a175-50eb64c95ec1"),
    ("Sameer - Problem Solver", "638efaaa-4d0c-442e-b701-3fae16aad012"),
    ("Nolan - Expressive Agent", "65209f8e-6140-4a20-b819-3cc2e21da19b"),
    ("Carson - Surprised Friendly Support", "66f5935b-af2e-4ec9-bb3e-59112e9ddc93"),
    ("Derek - Deep Advisor", "68fb6747-b6ea-4c44-a18e-4e29921424d3"),
    ("Thandi - Direct Dispatcher", "692846ad-1a6b-49b8-bfc5-86421fd41a19"),
    ("Sarah - Mindful Woman", "694f9389-aac1-45b6-b726-9d9369183238"),
    ("Stephanie - Steady Professional", "6a73e45f-3fa6-427c-97da-0fc6a7a1bc0d"),
    ("Steve - Surprised Baritone", "6fd4f468-0345-4f41-81d0-3f48ebc295e0"),
    ("Rowan - Team Leader", "701a96e1-7fdd-4a6c-a81e-a4a450403599"),
    ("Charlotte - Heiress", "71a7ad14-091c-4e8e-a314-022ece01c121"),
    ("Troy - Fix It Man", "726d5ae5-055f-4c3d-8355-d9677de68937"),
    ("Jake - Sidekick", "729651dc-c6c3-4ee5-97fa-350da1f88600"),
    ("Samantha - Happy Support Leader", "761afc95-bef5-44dd-aa07-d3c678912e43"),
    ("Savannah - Magnolia Belle", "78ab82d5-25be-4f7d-82b3-7ad64e5b85b2"),
    ("Luke - Disgusted Broadway Voice", "79b8126f-c5d9-4a73-8585-ba5e1a077ed6"),
    ("Wang - Guide", "79bfcec0-720c-41f2-a33a-f12383e9627f"),
    ("Theo - Modern Narrator", "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e"),
    ("Luke - Broadway Voice", "7b2c0a2e-3dd3-4a44-b16b-26ecd8134279"),
    ("Steve - Angry Baritone", "7c8ba972-4960-4c43-bea0-8178e2205696"),
    ("Benedict - Royal Narrator", "7cf0e2b1-8daf-4fe4-89ad-f6039398f359"),
    ("Joseph - Empathetic Voice", "7d444628-dd13-442b-b687-71a6baf0c07e"),
    ("Eleanor - Composed Clarifier", "7d7d769c-5ab1-4dd5-bb17-ec8d4b69d03d"),
    ("Silas - Nighttime Narrator", "7e19344f-9f17-47d7-a13a-4366ad06ebf3"),
    ("Janvi - Steady Agent", "7ea5e9c2-b719-4dc3-b870-5ba5f14d31d8"),
    ("Steve - Sad Baritone", "80713a53-e484-4f69-9852-7891096016ac"),
    ("Aina - Meditation Guru", "80c81aee-b6ad-4d12-9af8-a9c79c2e141d"),
    ("Pippa - Bright Assistant", "81cd8d19-45e7-47b2-ad0e-bcd94f557ad0"),
    ("Tyler - Friendly Salesman", "820a3788-2b37-4d21-847a-b65d8a68c99a"),
    ("Linda - Conversational Guide", "829ccd10-f8b3-43cd-b8a0-4aeaa81f3b30"),
    ("Eden - Clear Advisor", "83ae58a1-7e97-4b94-b03f-e4cc0a10d8af"),
    ("Carson - Curious Conversationalist", "86e30c1d-714b-4074-a1f2-1cb6b552fb49"),
    ("Henry - Plainspoken Guy", "87286a8d-7ea7-4235-a41a-dd9fa6630feb"),
    ("Alaric - Wizard", "87748186-23bb-4158-a1eb-332911b0b708"),
    ("Jordan - Chill Pal", "87bc56aa-ab01-4baa-9071-77d497064686"),
    ("Robyn - Storycrafter", "8985388c-1332-4ce7-8d55-789628aa3df4"),
    ("Ellie Mae - Friendly Companion", "8d2c9eda-31df-477a-9eb6-df6f00b82845"),
    ("Connie - Candid Conversationalist", "8d8ce8c9-44a4-46c4-b10f-9a927b99a853"),
    ("Aurora - Fairy Princess", "8f091740-3df1-4795-8bd9-dc62d88e5131"),
    ("Tina - Customer Ally", "91b4cf29-5166-44eb-8054-30d40ecc8081"),
    ("Connor - Grateful Person", "92c41dd4-04aa-45de-8504-a92b40cb8818"),
    ("Nathan - Easy Talker", "97f4b8fb-f2fe-444b-bb9a-c109783a857a"),
    ("Clyde - Calm Narrator", "98a34ef2-2140-4c28-9c71-663dc4dd7022"),
    ("Madison - Curious Best Friend", "98c87826-dba2-44f4-b123-4c7e3c8a2647"),
    ("Darla - Resolution Agent", "996a8b96-4804-46f0-8e05-3fd4ef1a87cd"),
    ("David - Disgusted Greeter", "9d2b4a7f-7ced-4fb8-b570-9ce21fb931c8"),
    ("Keith - Easygoing Friend", "9fa83ce3-c3a8-4523-accc-173904582ced"),
    ("Steve - Baritone", "9fb269e7-70fe-4cbe-aa3f-28bdb67e3e84"),
    ("Fiona - Witty Woman", "a01c369f-6d2d-4185-bc20-b32c225eab70"),
    ("Greg - Supporter", "a0e99841-438c-4a64-b679-ae501e7d6091"),
    ("Ellen - Welcome Agent", "a151affa-feaa-439e-8df8-c1d3f91dc6b9"),
    ("Blake - Helpful Agent", "a167e0f3-df7e-4d52-a9c3-f949145efdab"),
    ("Reflective Woman", "a3520a8f-226a-428d-9fcd-b0a4711a6829"),
    ("Lindsey - Relaxed Rep", "a38e4e85-e815-43ab-acf1-907c4688dd6c"),
    ("David - Scared Greeter", "a3a4fe2a-d402-41d1-be7d-28f71eda755f"),
    ("Jameson - Easygoing Support", "a5136bf9-224c-4d76-b823-52bd5efcffcc"),
    ("Madison - Surprised Best Friend", "a5def41e-2e73-433f-92f7-5f1d99fef05d"),
    ("Steve - Happy Baritone", "adde00e9-c98f-42ae-a94d-fc9f92f11c76"),
    ("Warren - Seasoned Pragmatist", "aec42b73-8c46-4528-a377-537b5ecb8e7b"),
    ("Valerie - Support Authority", "af346552-54bf-4c2b-a4d4-9d2820f51b6c"),
    ("David - Curious Greeter", "b08c966e-2146-4592-99eb-3171a714a43c"),
    ("Steve - Scared Baritone", "b1ce5126-4d08-42c3-adef-d3eb39e90c7a"),
    ("Amanda - Warm Guide", "b60048c2-abb5-43fa-b403-90dce232e55e"),
    ("Sierra - California Girl", "b7d50908-b17c-442d-ad8d-810c63997ed9"),
    ("Pieter - Polished Analyst", "baf84392-fa95-4d44-8871-d32ee36b0e01"),
    ("Arthur - Polished Advisor", "bb7e8daa-8b79-47a2-8408-a7a1cc72b53c"),
    ("Ben - Helpful Man", "bbee10a8-4f08-4c5c-8282-e69299115055"),
    ("Evan - Practical Guide", "bd89603f-0efb-4721-a0c8-d10b3642acc3"),
    ("Carol - Task Coach", "bf991597-6c13-47e4-8411-91ec2de5c466"),
    ("Matt - Goofy Friend", "bfd3644b-d561-4b1c-a01f-d9af98cb67c0"),
    ("Doreen - Decisive Coordinator", "c0832d40-57c5-4a34-991a-907b2cf0bfbf"),
    ("Steve - Curious Baritone", "c1c65fc2-528a-4dde-a2c4-f822785c2704"),
    ("Renee - Commander", "c2ac25f9-ecc4-4f56-9095-651354df60c0"),
    ("Lori - Surprised Cheerleader", "c2da2a3e-b0d6-46bf-a09a-68562617a50a"),
    ("Trevor - Movieman", "c45bc5ec-dc68-4feb-8829-6e6b2748095d"),
    ("David - Sad Greeter", "c4e848dc-d4fd-4bc8-90ea-8525563ec0e5"),
    ("Garrett - Enthusiastic Pal", "c58bda25-abd5-4c72-97a2-4dbe049b368d"),
    ("Harper - Conversationalist", "c5d00dfb-501f-43f3-8e79-c810d24f5acd"),
    ("Edith - Matriarch", "c8605446-247c-4d39-acd4-8f4c28aa363c"),
    ("Alistair - Composed Consultant", "c8f7835e-28a3-4f0c-80d7-c1302ac62aae"),
    ("Joan - Messenger", "c9440d34-5641-427b-bbb7-80ef7462576d"),
    ("Griffin - Narrator", "c99d36f3-5ffd-4253-803a-535c1bc9c306"),
    ("Faye - Hospitable Neighbor", "caa06a3e-c85d-459d-a1c0-4a25eeb60aeb"),
    ("Avery - Gaming Girl", "cccc21e8-5bcf-4ff0-bc7f-be4e40afc544"),
    ("Jolene - Warm Storyteller", "d1d9c946-7cfc-4378-85a4-07d09827cb7e"),
    ("Grant - Friendly Support", "d46abd1d-2d02-43e8-819f-51fb652c1c61"),
    ("Pearl - Calm Solutionist", "d6c52d6f-6478-47a2-ad54-dbc8f3335a2b"),
    ("Siobhan - Warm Welcomer", "d79d2b77-9192-4e10-9407-5d43ca034803"),
    ("Michelle - Empathetic Voice", "d7bf7d75-64b7-4c1e-86c0-79d647366587"),
    ("Callum - Brand Spokesperson", "da4a4eff-3b7e-4846-8f70-f075ff61222c"),
    ("Yasmin - Dialogue Anchor", "daf747c6-6bc2-4083-bd59-aa94dce23f5d"),
    ("Hana - Easygoing Support", "db408a93-859c-4a0a-b6a2-220c074cc90d"),
    ("Skylar - Friendly Guide", "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"),
    ("Victoria - Refined Coordinator", "dc30854e-e398-4579-9dc8-16f6cb2c19b9"),
    ("Gary - Composed Advisor", "dc52ada6-0e11-4684-a8fa-e0af5b7bdcb2"),
    ("Harrison - Diligent Detailer", "df89f42f-f285-4613-adbf-14eedcec4c9e"),
    ("Zeke - Friendly Sidekick", "e00d0e4c-a5c8-443f-a8a3-473eb9a62355"),
    ("Lulu - Madame Mischief", "e13cae5c-ec59-4f71-b0a6-266df3c9bb8e"),
    ("Dottie - Sweet Gal", "e3827ec5-697a-4b7c-9704-1a23041bbc51"),
    ("Evie - Engaging Expert", "e5d4c33a-d8f6-46e8-a10f-b5afecc35648"),
    ("Cathy - Coworker", "e8e5fffb-252c-436d-b842-8879b84445b6"),
    ("Jasper - Vibrant Stylist", "e98bd614-9b9d-4031-b930-ed72482af858"),
    ("Heath - Calm & Composed", "eb7d0d3b-e427-483b-bbca-1c009c33f8a7"),
    ("Zack - Sportsman", "ed81fd13-2016-4a49-8fe3-c0d2761695fc"),
    ("Ruby - Helpful Handler", "ed9ccfa4-8fa1-40f8-bfb2-cb7d67d2f9cd"),
    ("Oliver - Customer Chap", "ee7ea9f8-c0c1-498c-9279-764d6b56d189"),
    ("Carson - Disgusted Friendly Support", "ee8b13e7-98af-4b15-89d1-8d402be10c94"),
    ("Cindy Baker - Receptionist", "f039066f-cdb7-45ed-b51d-1034ae2f04a0"),
    ("Ethan - Casual Assistant", "f0e50f2a-9116-4510-9c5b-fec928daff4b"),
    ("Miles - Yogi", "f114a467-c40a-4db8-964d-aaba89cd08fa"),
    ("Roy - Stern Realist", "f2ddbdca-59d9-4363-abeb-a197d65ea24a"),
    ("Olivia - Sunny Woman", "f31cc6a7-c1e8-4764-980c-60a361443dd1"),
    ("Whitney - Composed Concierge", "f3c7d5d2-c1e1-41a0-bd88-8b5512be5335"),
    ("Samantha - Support Leader", "f4e8781b-a420-4080-81cf-576331238efa"),
    ("Priya - Trusted Operator", "f6141af3-5f94-418c-80ed-a45d450e7e2e"),
    ("Claudia - Welcoming Lady", "f80e7298-93f5-46d0-86f2-b8f29cfc88bd"),
    ("Kiara - Joyful Woman", "f8f5f1b2-f02d-4d8e-a40d-fd850a487b3d"),
    ("Steve - Disgusted Baritone", "f96dc0b1-7900-4894-a339-81fb46d515a7"),
    ("Caroline - Southern Guide", "f9836c6e-a0bd-460e-9d3c-f7299fa60f94"),
    ("Ailsa - Warm Guide", "fb02b554-7d64-4f90-841e-e57fc88f410c"),
    ("David - Angry Greeter", "fd098a10-ba9e-445e-b144-be2a9f3dac02"),
    ("Betty - Reassured Guide", "fdd6abff-902a-4885-9f5f-0d3d9f7567e5"),
]


# --------------------------------------------------------------------------
# Transcript parsing
# --------------------------------------------------------------------------

def _text_blocks(content) -> str:
    """Join the text blocks of a message content (string or block list)."""
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = [
        b.get("text", "")
        for b in content
        if isinstance(b, dict) and b.get("type") == "text"
    ]
    return "\n\n".join(p for p in parts if p.strip()).strip()


def _is_tool_result(content) -> bool:
    """True if this user content is a tool result (not a typed prompt)."""
    return isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content
    )


# Async-work lifecycle markers, matched against raw transcript lines. Two kinds
# of work keep running across turns and re-invoke the agent via a completion
# notification later, so an end-turn while one is outstanding means the agent is
# waiting, not reporting:
#   - a `run_in_background` Bash command, acked "Command running in background
#     with ID: <id>";
#   - an async sub-agent (the Agent tool), acked "Async agent launched
#     successfully ... agentId: <id>".
# Both complete via a task-notification carrying "<task-id><id></task-id>"
# alongside a "<status>" (completed/failed/killed) — for a sub-agent the id is
# its agentId, so the SAME completion detector covers both. The completion is
# recorded twice (a queue-operation and the injected user event), so we de-dupe
# by id rather than counting raw occurrences. We anchor the sub-agent launch on
# the "launched successfully" phrase because "agentId: ..." also shows up in
# ordinary source code the agent reads.
_BG_LAUNCH_RE = re.compile(r"Command running in background with ID: ([a-z0-9]+)")
_AGENT_LAUNCH_MARK = "Async agent launched successfully"
_AGENT_ID_RE = re.compile(r"agentId: ([a-z0-9]+)")
_BG_DONE_RE = re.compile(r"<task-id>([a-z0-9]+)</task-id>")


def parse_conversation(path: str) -> tuple[list[dict], int, str | None, list[int]]:
    """Parse the transcript into ordered conversational turns.

    Returns (turns, complete_bytes, entrypoint, bg_events). Each turn is
    {"role", "text", "pos"} for genuine user prompts and assistant text
    messages, skipping thinking, tool calls, tool results, and harness metadata.
    `pos` is the byte offset where that turn's line begins — used as a byte
    high-water mark for what's already been spoken (stable because the file is
    append-only). Only newline-terminated content is parsed; `complete_bytes` is
    the size of that region, so a partially-written trailing line is excluded
    until it completes. `entrypoint` is how the session was launched (e.g. "cli"
    for an interactive terminal, "sdk-cli" for a headless `claude -p` run) — the
    caller uses it to mute non-interactive sessions. `bg_events` is a sorted list
    of (byte_offset, delta) where delta is +1 when async work (a
    `run_in_background` command or an async sub-agent) launches and -1 when it
    completes; the caller sums deltas before a turn to tell whether any such work
    is still outstanding (and mutes the turn if so).
    """
    try:
        with open(path, "rb") as f:
            data = f.read()
    except (FileNotFoundError, OSError):
        return [], 0, None, []

    cut = data.rfind(b"\n")
    if cut == -1:
        return [], 0, None, []
    complete = data[: cut + 1]

    turns: list[dict] = []
    launch_pos: dict[str, int] = {}   # bg task id -> byte offset it was launched
    done_pos: dict[str, int] = {}     # bg task id -> byte offset it completed
    entrypoint = None
    pos = 0
    for raw in complete.split(b"\n"):
        start = pos
        pos += len(raw) + 1  # +1 for the newline split removed
        line = raw.strip()
        if not line:
            continue

        # Track background-task lifecycle by id from the raw line text (the
        # markers live inside tool_result / notification payloads). Keep the
        # earliest offset per id; the completion is recorded more than once.
        line_text = raw.decode("utf-8", "replace")
        launch = _BG_LAUNCH_RE.search(line_text)
        if launch:
            launch_pos.setdefault(launch.group(1), start)
        elif _AGENT_LAUNCH_MARK in line_text:
            agent = _AGENT_ID_RE.search(line_text)
            if agent:
                launch_pos.setdefault(agent.group(1), start)
        if "<status>" in line_text:
            for tid in _BG_DONE_RE.findall(line_text):
                done_pos.setdefault(tid, start)

        try:
            event = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(event, dict):
            continue

        # How the session was launched ("cli", "sdk-cli", …). Stable across a
        # session; capture the first one we see. Only assistant/user lines carry
        # it, so metadata-only lines leave it None until a real event appears.
        if entrypoint is None:
            entrypoint = event.get("entrypoint")

        kind = event.get("type")
        if kind == "assistant":
            message = event.get("message", {})
            content = message.get("content")
            text = _text_blocks(content)
            if text:
                # stop_reason "end_turn" marks the message where the agent
                # stopped and handed back to the user; "tool_use" is mid-turn.
                turns.append({"role": "assistant", "text": text, "pos": start,
                              "stop_reason": message.get("stop_reason")})
        elif kind == "user":
            content = event.get("message", {}).get("content")
            if _is_tool_result(content):
                continue
            text = _text_blocks(content)
            if text:
                turns.append({"role": "user", "text": text, "pos": start,
                              "stop_reason": None})

    # +1 where a background task launches, -1 where it completes. Only emit a
    # completion for a task we actually saw launch, so a stray notification
    # can't drive the outstanding count negative.
    bg_events = [(p, 1) for p in launch_pos.values()]
    bg_events += [(done_pos[tid], -1) for tid in launch_pos if tid in done_pos]
    bg_events.sort()
    return turns, len(complete), entrypoint, bg_events


# --------------------------------------------------------------------------
# Summarization via `claude -p`
# --------------------------------------------------------------------------

INSTRUCTION = (
    "You are turning a coding agent's just-completed turn into a very short "
    "SPOKEN audio update for the user. You are given the agent's most recent "
    "turn — the user's latest message and everything the agent said in "
    "response, ending with its concluding message — plus a list of updates "
    "already spoken aloud to the user. In one or two short sentences of plain "
    "spoken English, say what the agent communicated or accomplished in this "
    "turn — focus on the genuinely NEW information and don't restate what was "
    "already spoken. No markdown, no lists, no code, no preamble, no quotation "
    "marks. Output ONLY the spoken update."
)


def read_oauth_token() -> str | None:
    """Read the Claude Code OAuth access token from the macOS Keychain.

    Read fresh on every call so we automatically pick up the token your running
    Claude Code session refreshes (the entry is rotated well before expiry).
    Returns None if the keychain has no usable credentials.
    """
    try:
        raw = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE,
             "-a", os.environ.get("USER", "unknown"), "-w"],
            capture_output=True, text=True, timeout=3,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if raw.returncode != 0 or not raw.stdout.strip():
        return None
    try:
        return json.loads(raw.stdout)["claudeAiOauth"]["accessToken"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return None


def summarize(context: list[dict], spoken_summaries: list[str]) -> str:
    """Compress the latest assistant turn into a short spoken update.

    Calls the Anthropic Messages API directly with the Keychain OAuth token.
    `spoken_summaries` are recent updates already read aloud for this session,
    given so haiku can avoid restating them. Returns the spoken update text, or
    the raw latest message as a fallback if auth/the request fails (so playback
    never stalls on a transient API error). Whether a message is spoken at all
    is decided by the caller (the trailing-colon pre-filter), not here.
    """
    latest = context[-1]["text"]
    token = read_oauth_token()
    if not token:
        print("warning: no OAuth token in Keychain; speaking raw message",
              file=sys.stderr)
        return latest

    transcript = "\n\n".join(
        f"{t['role'].upper()}: {t['text']}" for t in context
    )
    already = "\n".join(f"- {s}" for s in spoken_summaries) or "(nothing yet)"
    body = json.dumps({
        "model": SUMMARY_MODEL,
        "max_tokens": 200,
        # OAuth (subscription) tokens require the Claude Code identity as the
        # first system block; our instruction follows as a second block.
        "system": [
            {"type": "text",
             "text": "You are Claude Code, Anthropic's official CLI for Claude."},
            {"type": "text", "text": INSTRUCTION},
        ],
        "messages": [{"role": "user", "content": (
            f"ALREADY SPOKEN ALOUD (do not repeat these):\n{already}\n\n"
            f"--- CONVERSATION ---\n\n{transcript}"
        )}],
    }).encode()

    req = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "User-Agent": "claude-code/2.1.47",
    })
    try:
        with urllib.request.urlopen(req, timeout=API_TIMEOUT_S) as r:
            out = json.load(r)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        detail = exc.read()[:200].decode("utf-8", "replace") if hasattr(exc, "read") else exc
        print(f"warning: summary API failed ({detail!r}); speaking raw message",
              file=sys.stderr)
        return latest

    summary = "".join(
        b.get("text", "") for b in out.get("content", []) if isinstance(b, dict)
    ).strip().strip('"').strip()
    return summary or latest


# --------------------------------------------------------------------------
# Text-to-speech
# --------------------------------------------------------------------------

def pick_voice(session_id: str) -> tuple[str, str]:
    """Deterministically map a session id to an English voice.

    The same session always picks the same voice; different sessions spread
    across the pool. Uses sha256 (not the salted built-in hash) so the choice
    is stable across runs/processes.
    """
    digest = hashlib.sha256(session_id.encode()).digest()
    return ENGLISH_VOICES[int.from_bytes(digest, "big") % len(ENGLISH_VOICES)]


def notify_spaceterm(event: dict) -> None:
    """Fire-and-forget a newline-JSON event to spaceterm's hooks.sock.

    Best-effort: if spaceterm isn't running (no socket), or the write fails, we
    silently skip — speaking must never depend on spaceterm being up.
    """
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(0.5)
        sock.connect(SPACETERM_HOOKS_SOCKET)
        sock.sendall((json.dumps(event) + "\n").encode())
        sock.close()
    except OSError:
        pass


def speak(text: str, voice_id: str, claude_session_id: str, voice_name: str) -> None:
    """Pipe `text` into cartesia-read (with a chosen voice) and block.

    Brackets the utterance with tts-speaking start/stop events to spaceterm so a
    surface can be shown as talking; the stop always fires, even on error.
    """
    env = dict(os.environ)
    env["CARTESIA_VOICE_ID"] = voice_id
    notify_spaceterm({"type": "tts-speaking", "speaking": True,
                      "claudeSessionId": claude_session_id,
                      "voice": voice_name, "text": text})
    try:
        result = subprocess.run(
            [CARTESIA_READ, "-"], input=text, text=True, env=env,
        )
        if result.returncode != 0:
            print(f"warning: {CARTESIA_READ} exited {result.returncode}",
                  file=sys.stderr)
    except FileNotFoundError:
        print(f"error: {CARTESIA_READ} not found on PATH", file=sys.stderr)
        sys.exit(1)
    finally:
        notify_spaceterm({"type": "tts-speaking", "speaking": False,
                          "claudeSessionId": claude_session_id})


# --------------------------------------------------------------------------
# Watch loop
# --------------------------------------------------------------------------

def session_id_of(path: str) -> str:
    """The session id is the transcript filename stem."""
    return os.path.splitext(os.path.basename(path))[0]


def handle_change(path: str, state: dict) -> None:
    """Speak any assistant turns in `path` whose byte offset is past `consumed`.

    Updates state["consumed"] so already-spoken turns aren't repeated. Opens the
    file only transiently (via parse_conversation) — no handle is retained.
    """
    turns, complete_bytes, entrypoint, bg_events = parse_conversation(path)
    sid = session_id_of(path)

    # Mute headless / SDK-launched sessions. A `claude -p` run — which is how
    # tools, subagents, scheduled jobs, and even our own summarizer spawn
    # Claude — records its entrypoint as "sdk-cli" (and the SDKs as "sdk-py"
    # etc.), whereas an interactive terminal session is "cli". Narrating these
    # surfaces work the user never directly asked for (e.g. a background
    # code-review subagent reading its findings aloud), so we skip any session
    # whose entrypoint is in the "sdk" family. We match the prefix rather than
    # allowlisting "cli" so a genuinely interactive IDE entrypoint still speaks.
    # We still advance `consumed` so the session is treated as handled.
    if entrypoint is not None and entrypoint.startswith("sdk"):
        if not state.get("muted"):
            state["muted"] = True
            print(f"muting {sid} (headless entrypoint: {entrypoint}, e.g. claude -p)",
                  file=sys.stderr)
        state["consumed"] = max(state["consumed"], complete_bytes)
        return

    if state["voice"] is None:
        state["voice"] = pick_voice(sid)
    voice_name, voice_id = state["voice"]

    for i, turn in enumerate(turns):
        if turn["role"] != "assistant" or turn["pos"] < state["consumed"]:
            continue
        # Speak once per turn: only when the agent has stopped and handed back
        # to the user (stop_reason "end_turn"). Intermediate messages — tool-use
        # preambles and mid-turn notes — stay as context but aren't spoken.
        if turn.get("stop_reason") != "end_turn":
            continue
        # Context = just this turn: everything since the previous end-of-turn
        # marker — the user's latest message and the agent's replies through
        # this concluding one. We don't look back past the prior turn.
        prev = i - 1
        while prev >= 0 and not (
            turns[prev]["role"] == "assistant"
            and turns[prev].get("stop_reason") == "end_turn"
        ):
            prev -= 1
        # Suppress turns while any background task is still outstanding. Summing
        # the launch (+1) / completion (-1) deltas that occur before this turn
        # tells us how many `run_in_background` tasks have been started but not
        # yet finished. If that's > 0 the agent is monitoring — it ended the turn
        # to wait on backgrounded work (e.g. a `claude -p` round), not to hand a
        # result to the user — so we stay silent until everything has resolved.
        outstanding = sum(d for p, d in bg_events if p < turn["pos"])
        if outstanding > 0:
            print(f"[{sid} · {voice_name}] (skipped: {outstanding} background "
                  f"task(s)/sub-agent(s) still running)", file=sys.stderr)
            continue

        context = turns[prev + 1: i + 1]
        summary = summarize(context, state["spoken"])
        print(f"[{sid} · {voice_name}] {summary}", file=sys.stderr)
        speak(summary, voice_id, sid, voice_name)
        # Remember what we actually said so future updates don't repeat it.
        state["spoken"].append(summary)
        del state["spoken"][:-SPOKEN_HISTORY]
    state["consumed"] = max(state["consumed"], complete_bytes)


def watch(list_paths, replay: bool) -> None:
    """Poll a changing set of transcripts and speak new assistant messages.

    `list_paths()` returns the current set of transcript paths (one fixed file,
    or a fresh glob over all projects). State per path is just a few numbers/
    refs held in RAM — {size, consumed, voice, spoken} — so no file handles
    linger and the footprint stays flat over a weeks-long run.

    Files present at startup are baselined immediately. A file that appears
    later (a new or forked session) is held in `pending` until its size settles,
    then baselined too — so a forked session's copied history is skipped and
    only subsequent interaction is spoken.
    """
    states: dict[str, dict] = {}        # baselined, actively tailed
    pending: dict[str, dict] = {}       # newly-appeared, awaiting settle

    def baseline(path: str, size: int, replaying: bool) -> None:
        states[path] = {"size": size, "consumed": 0 if replaying else size,
                        "voice": None, "spoken": []}

    # Baseline everything present at startup: skip its backlog, tail from here.
    for path in list_paths():
        try:
            baseline(path, os.path.getsize(path), replay)
        except OSError:
            continue

    if replay:
        for path in list(states):
            handle_change(path, states[path])

    print(f"watching {len(states)} transcript(s); "
          f"{'replaying backlog + ' if replay else ''}tailing new activity",
          file=sys.stderr)

    try:
        while True:
            now = time.monotonic()
            current = set(list_paths())
            # Drop state for deleted/archived sessions to bound memory.
            for gone in set(states) - current:
                del states[gone]
            for gone in set(pending) - current:
                del pending[gone]

            for path in current:
                try:
                    size = os.path.getsize(path)
                except OSError:
                    continue

                state = states.get(path)
                if state is not None:
                    if size == state["size"]:
                        continue
                    if size < state["size"]:
                        state["consumed"] = 0  # truncated/replaced — re-read
                    state["size"] = size
                    handle_change(path, state)
                    continue

                # Not yet baselined: a file that appeared after startup. Wait for
                # its size to settle before deciding the baseline, so a slow or
                # whole-cloth fork-copy lands entirely in the backlog we skip.
                p = pending.get(path)
                if p is None:
                    pending[path] = {"size": size, "changed": now, "first": now}
                    continue
                if size != p["size"]:
                    p["size"] = size
                    p["changed"] = now
                if (now - p["changed"] >= SETTLE_SECONDS
                        or now - p["first"] >= MAX_SETTLE_WAIT):
                    baseline(path, size, replaying=False)
                    del pending[path]
                    print(f"baselined new session {session_id_of(path)[:8]} "
                          f"({size} B skipped as backlog)", file=sys.stderr)

            time.sleep(POLL_INTERVAL_S)
    except KeyboardInterrupt:
        print("\nstopped.", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description="Read Claude Code agent messages aloud.")
    ap.add_argument("transcript", nargs="?",
                    help="path to a single <session-id>.jsonl to watch")
    ap.add_argument("--all", action="store_true",
                    help="watch every Claude Code transcript across all projects")
    args = ap.parse_args()

    if args.all:
        if args.transcript:
            ap.error("pass either a transcript path or --all, not both")
        # Never replay thousands of historical sessions in --all mode.
        watch(lambda: glob.glob(TRANSCRIPTS_GLOB), replay=False)
    else:
        if not args.transcript:
            ap.error("provide a transcript path, or use --all")
        path = os.path.abspath(args.transcript)
        if not os.path.exists(path):
            ap.error(f"file not found: {path}")
        watch(lambda: [path] if os.path.exists(path) else [], replay=READ_BACKLOG)


if __name__ == "__main__":
    main()
