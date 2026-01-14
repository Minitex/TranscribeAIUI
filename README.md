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

- **Electron**: Main process for file I/O and IPC  
- **React + TypeScript**: Renderer UI, bundled with Vite for fast HMR  
- **Vite**: Modern build tool for instant feedback and optimized production builds  
- **google-generativeai SDK**: Interfaces with LLMs for high-quality transcription  
- **electron-store**: Simple JSON storage for your Gemini API key


## Setup & Installation

1. **Obtain your API keys**
   - **Gemini (required for audio/Gemini OCR):** Sign in to AI Studio and create a key at the [Google AI Studio API Key Console](https://aistudio.google.com/app/apikey?_gl=1*im4t83*_ga*MTM3ODUyOTU5Ny4xMTM5NDc4MjA0*_ga_P1DBVKWT6V*MTc0NjQ1NDYyNC4xMi4xLjE3NDY0NTQ2MzguNDYuMC4xNjUyODg3NDI). Copy the generated key.
   - **Mistral (only for Mistral OCR):** Create an API key in your Mistral account—follow the Mistral quickstart at [docs.mistral.ai/getting-started/quickstart](https://docs.mistral.ai/getting-started/quickstart).

2. **Download TranscribeAI**
   - Go to the [TranscribeAI Releases page](https://github.com/Minitex/TranscribeAIUI/releases).  
   - Choose the installer for your OS:  
     - **macOS:** `.dmg`  
     - **Windows:** `.exe`  
     - **Linux:** `.AppImage` or `.tar.gz`  
   - Download and run the installer. Because TranscribeAI is an open-source project and we don’t bundle a paid code-signing certificate, you may see a security warning the first time you run it:  
     - **macOS Gatekeeper** (“Unidentified Developer” or "damaged and can't be opened"): open **System Preferences → Security & Privacy**, then click **Open Anyway** next to the TranscribeAI entry.  
     - **Windows SmartScreen** (“Windows protected your PC”): click **More info**, then **Run anyway**.  
   - Follow the installer prompts to complete installation.

3. **Configure your API key(s)**
   - Launch **TranscribeAI**.
   - Click the **gear icon** in the top-right corner to open Settings.
   - Paste your Google Gemini API key into the “API Key” field.
   - If you plan to use Mistral OCR, paste your Mistral API key into the “Mistral API Key” field.
   - Click **Save**.

4. **Run your first transcription**
   - Click the file picker button to select an audio file or image folder, then choose the output folder for your transcripts.
   - Click **Transcribe** to begin transcription.
   - Monitor progress and logs in real time.

### Using Mistral OCR (including batch mode)
- In Settings, enter your Mistral API key (leave Gemini key as well if you use Gemini features).
- In the Image tab, pick the `mistral-ocr-latest` model.
- Select an input folder of images/PDFs and an output folder.
- Enable **Batch mode** to process files in batches, then start transcription. The app will call Mistral’s batch OCR and write outputs to your chosen folder.
- Adjust **Batch size** with the +/− controls (default 50, range 10–500) to balance throughput vs. request size.
- Note: single-image Mistral OCR calls are free; batch OCR requires a paid Mistral account.

## Updating to a New Version
- **macOS:** Download the latest `.dmg` from Releases, open it, and drag the app to **Applications**. Choose “Replace” if prompted. If Gatekeeper blocks, right-click → **Open** once.
- **Windows:** Download the new installer `.exe` from Releases and run it; it overwrites the existing install.
  *Tip: after first launch, right-click the TranscribeAI icon on the taskbar → **Pin to taskbar** so it’s easy to find next time.*
- **Linux (AppImage):** Download the new `*.AppImage`, `chmod +x` if needed, and replace your old AppImage file.
- **No uninstall needed:** Install over the top; your existing data and settings remain.

## Screenshots

<table align="center">
  <tr>
    <td>
      <img src="transcribeAIMainView.jpeg" alt="TranscribeAI Main Interface" width="600">
    </td>
  </tr>
  <tr>
    <td>
      <img src="transcribeAISettingsView.jpeg" alt="TranscribeAI Settings" width="600">
    </td>
  </tr>
</table>
