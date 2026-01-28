import { NextRequest, NextResponse } from "next/server";
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";

export async function POST(req: NextRequest) {
    const { message } = await req.json();
    console.log("Received user message:", message);
  try {
    const client = new BedrockAgentRuntimeClient({
      region: "us-east-1"
    });

    const command = new InvokeAgentCommand({
      agentId: process.env.BEDROCK_AGENT_ID,
      agentAliasId: process.env.BEDROCK_AGENT_ALIAS_ID,
      sessionId: crypto.randomUUID(),
      inputText: message,
    });

    const response = await client.send(command);

    let finalText = "";

    if (response.completion) {
      for await (const event of response.completion) {
        if (event.chunk?.bytes) {
          finalText += new TextDecoder().decode(event.chunk.bytes);
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: finalText,
    });

  } catch (error: any) {
    console.error(" Bedrock Agent error:", error);

   
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Unknown server error",
      },
      { status: 500 }
    );
  }
}
