# Modal Runtime Wrapper

Everything Modal-related is isolated in this folder.

## Files

- `run`: shell entrypoint
- `modal_runner.py`: Modal Sandbox runner

## Usage

```bash
./modal/run -- <command>
./modal/run --port 3000 -- npm run dev
```

The command output streams to your local terminal.  
If a port is exposed, a Modal tunnel URL is printed.
