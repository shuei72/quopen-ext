<p align="center">
  <img src="media/icon.png" alt="Quopen icon" width="128" />
</p>

# Quopen

Quopen is a VS Code extension that enables recursive narrowing in Quick Open by letting you select folders as well as files.  
It is designed for workspaces with many similarly named files where moving through folder context is faster than plain filename search.

## ✨ Features

- Shows folders and files together in one list.
- Lets you keep drilling into a selected folder with another recursive list.
- Shows file and folder icons in the list.
- Supports multi-root workspaces.
- Uses Everything on Windows when available to generate lists quickly.

### Recommended on Windows

Quopen works without Everything, but using Everything on Windows is strongly recommended.  
When `es.exe` is available, Quopen can use Everything as its search backend and usually responds much faster on large workspaces.  
(`es.exe` is the command-line interface provided by Everything.)

## ⌨️ Commands

`Quopen: Quick Open by Folder`  
Shows folders and files in one list. Selecting a folder narrows the list recursively, and selecting a file opens it.

## ⚙️ Settings

`quopen.searchBackend`  
Selects the search backend. `auto` prefers Everything on Windows and falls back to the native workspace index.  
Values: `auto`, `everything`, `native`

`quopen.everythingPath`  
Optional absolute path to `es.exe` when using the Everything backend.

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
