<table align="center">
  <tr>
    <td>
      <img src="./desktopIcon.svg" alt="TranscribeAI Logo" width="300">
    </td>
  </tr>
</table>

**TranscribeAI** is a cross-platform desktop app that uses Large Language Models to transcribe audio files and scanned images/pages. It features:

- **LLM-powered transcription** (e.g. Google Gemini via `google-generativeai`)
- **Resumable image workflows** (skips already-done files, cleans up partial outputs)
- **Real-time logs & progress** in the UI
- **Persistent settings** (stores your API key with `electron-store`)
- **Drag-resizable, searchable sidebar** for managing transcripts

> **Note:** A “headless” version (no UI) is also available and can be integrated into your own system—see  
> https://github.com/Minitex/TranscribeAI  

## Technologies

- **Electron**: Main process for file I/O, spawning Python/CLI binaries, and IPC  
- **React + TypeScript**: Renderer UI, bundled with Vite for fast HMR  
- **Vite**: Modern build tool for instant feedback and optimized production builds  
- **Python CLI**: Native binaries handle image prep & OCR  
- **google-generativeai SDK**: Interfaces with LLMs for high-quality transcription  
- **electron-store**: Simple JSON storage for your Gemini API key