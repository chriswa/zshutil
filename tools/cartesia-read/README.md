# cartesia-read

Read text and markdown files aloud using [Cartesia](https://cartesia.ai/) TTS. Streams audio in real time over WebSocket — press Ctrl+C to stop at any point (unsent text is never billed).

## Prerequisites

- [uv](https://docs.astral.sh/uv/) (Python package runner)
- [ffplay](https://ffmpeg.org/) (ships with ffmpeg)

On macOS:

```bash
brew install uv ffmpeg
```

## Setup

1. Clone this repo:

   ```bash
   git clone <repo-url> ~/cartesia-read
   cd ~/cartesia-read
   ```

2. Copy the example env file and add your Cartesia API key:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and replace `sk_car_your_key_here` with your key from [play.cartesia.ai](https://play.cartesia.ai/).

3. Symlink the script onto your PATH:

   ```bash
   ln -sf ~/cartesia-read/cartesia-read ~/.local/bin/cartesia-read
   ```

   Make sure `~/.local/bin` is in your `PATH`. If it isn't, add this to your shell rc file:

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   ```

That's it. The first run takes a few seconds while `uv` caches the Python dependencies; subsequent runs start instantly.

## Usage

```bash
cartesia-read README.md            # read a file
cartesia-read path/to/notes.md     # any text or markdown file
echo "Hello world" | cartesia-read # pipe from stdin
```

Press **Ctrl+C** to stop playback. The WebSocket closes immediately and no further text is sent to the API.

## Configuration

The script reads `CARTESIA_API_KEY` from (in order):

1. The `CARTESIA_API_KEY` environment variable
2. The `.env` file in this repo (follows the symlink)

Voice, model, and sample rate are configured at the top of `cartesia-read`.
