# ToDo.md

This file provides a list, sorted by category and not in any particular order, of desired features or improvements to be added to the transcription app. 

## Fixes
- Fix thing where it gives you cached transcript automatically for files that aren't the same
- Clean up codebase
- Fix errors with large video files
- Speed up functions that turn .json into DOCX/XML (optimize formatting pipeline)
- ~~**URGENT**: Replace temporary even-distribution timestamp interpolation strategy with more robust solution~~
  - **COMPLETED**: Implemented AssemblyAI integration with word-level timestamps
  - AssemblyAI now provides accurate per-line timing using word-level data
  - Gemini integration has been removed from the codebase

### Additional Features/Capabilities, Generally
- Devise internal transcription benchmark using a human-generated transcript and audio file
- Provide other methods to transcribe besides u.i; e.g. Box, DropBox, Zapier, Email integrations/automations
- Create cache/persistent storage of past transcripts, "history" page
- Batch processing?
- Make the UI look more professional
- Optional AI Summary

### Changes to Core Transcribing Functionality
- Remove need for Gemini vs AssemblyAI comparison (AssemblyAI is the sole engine)
- Improve OnCue transcript formatting
- ~~Delete option to enter number of lines per page~~
  - **COMPLETED**: Backend uses fixed 25 lines per page for OnCue XML
  - Frontend control removed to avoid user confusion
### Logistics, Deployment, Etc.
- Setup login system w/api key management, etc. 
- Figure out cost tracking

## Transcript Editor
- Create a transcript editor for both synced and unsynced transcripts, or else integrate with external editor and allow re-importing/re-syncing of oncue transcripts

## Sync Mode
- Create sync mode using forced allignment to produce OnCue transcripts from human-generated pdfs/docx. Ensure persistent formatting accross different styles, line numbering schema

## FFMPEG Clip Creator
- Features:
 - Clip by timestamp
 - Clip by transcript
    - Page/line numbers
    - 'when X said Y'
    - Highlight/select interface
 - Convert between formats, mute audio/separate, compress/reduce size 
