# Quopen

Quopen is a VS Code extension that enables recursive narrowing in Quick Open by letting you select folders as well as files.  
It is designed for workspaces with many similarly named files where moving through folder context is faster than plain filename search.

## Commands

`Quopen: Quick Open by Folder`  
Shows folders and files in one list. Selecting a folder narrows the list recursively, and selecting a file opens it.

## Features

- Shows folders and files together in one list.
- Lets you keep drilling into a selected folder with another recursive list.
- Shows file and folder icons in the list.
- Supports multi-root workspaces.
- Uses Everything on Windows when available to generate lists quickly.

## Recommended on Windows

Quopen works without Everything, but using Everything on Windows is strongly recommended.  
When `es.exe` is available, Quopen can use Everything as its search backend and usually responds much faster on large workspaces.  
(`es.exe` is the command-line interface provided by Everything.)

- Recommended setting: `quopen.searchBackend = auto`
- Optional setting: `quopen.everythingPath = C:\\Path\\To\\es.exe`
- If Everything is unavailable, Quopen automatically falls back to the native workspace index.

## Development

### PowerShell

```powershell
npm.cmd install
npm.cmd run compile
npm.cmd run package
```

### Command Prompt

```cmd
npm install
npm run compile
npm run package
```

## Other

- This extension was created with Codex.

## License

MIT License
