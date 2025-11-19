import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

// Initialize Gemini API with the SERVER-SIDE key
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// The secret access code stored in Vercel Environment Variables
const SERVER_ACCESS_CODE = process.env.ACCESS_CODE || "TAGLISH2025";

export async function POST(req: NextRequest) {
  if (!ai) {
    return NextResponse.json(
      { error: "Server misconfiguration: GEMINI_API_KEY is missing." },
      { status: 500 }
    );
  }

  try {
    const body = await req.json();
    const { audioData, mimeType, speakerNames, accessCode } = body;

    // 1. Security Check
    if (accessCode !== SERVER_ACCESS_CODE) {
      return NextResponse.json(
        { error: "Invalid Access Code." },
        { status: 401 }
      );
    }

    if (!audioData || !mimeType) {
      return NextResponse.json(
        { error: "Missing audio data." },
        { status: 400 }
      );
    }

    // 2. Prepare Gemini Request
    // gemini-2.5-flash is efficient and capable for audio transcription
    const model = 'gemini-2.5-flash';

    const audioPart = {
      inlineData: {
        mimeType: mimeType,
        data: audioData,
      },
    };

    const textPart = {
      text: `You are an expert transcriber for meetings in the Philippines. 
      
      Context:
      - The language is a mix of Tagalog and English (Taglish).
      - The list of known participants/speakers in this meeting is: ${speakerNames || "Not provided"}.

      Instructions:
      1. Provide a CLEAN and ACCURATE transcription.
      2. **TIMESTAMPS**: Include a timestamp at the start of every new speaker turn (e.g., "[00:12:05] Speaker Name:").
      3. **SPEAKERS**: Identify speakers by name. If unknown, use "Speaker 1", "Speaker 2".
      4. **TAGLISH**: Ensure Tagalog and English switching is transcribed naturally and accurately. Do not translate; transcribe exactly what was said.
      5. **OVERLAP**: If the audio starts with a sentence that seems cut off or repeated from a previous segment, transcribe it anyway to ensure nothing is lost.
      `,
    };

    // 3. Call Gemini
    const response = await ai.models.generateContent({
      model: model,
      contents: { parts: [audioPart, textPart] },
    });

    const transcription = response.text || "No transcription generated.";

    return NextResponse.json({ transcription });

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
