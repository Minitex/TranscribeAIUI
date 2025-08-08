
export const DEFAULT_AUDIO_PROMPT = `Generate a time-stamped transcript of the episode, one caption per line:

[HH:MM:SS] Text

For music or jingles use [MUSIC] or the title if known (e.g. [Firework by Katy Perry]).  
For other sounds use [Bell ringing], [Applause], etc.

Keep each caption short (a sentence or two).  
End the transcript with [END].  
Do not use any Markdown formatting.  
Spell everything correctly in English.`;

export const SUBTITLE_AUDIO_PROMPT = `Please create subtitles in SRT format for the attached video. Make sure you:
- Use proper SRT timestamp format (00:00:00,000)
- Limit to one line per subtitle entry
- Keep subtitle segments short and readable
- Ensure timestamps match the audio precisely
- Format exactly like this example:

1
00:00:00,000 --> 00:00:03,500
Your subtitle text here

2
00:00:03,630 --> 00:00:07,200
Next subtitle text here`;

export const INTERVIEW_AUDIO_PROMPT = `You're a professional transcriber. Generate audio diarization for this interview. Use JSON format for the output, with the following keys: "speaker", "transcription". If you can infer the speaker, please do. If not, use speaker A, speaker B, etc.`;

export const DEFAULT_IMAGE_PROMPT = `You're a professional transcriber. Transcribe exactly the text from the uploaded image. Provide only the exact transcription without introductions, explanations, or closing remarks. Ensure correct English spelling, grammar, and sentence structure. Mark completely missing words as [blank] and unclear words as [unsure].`;