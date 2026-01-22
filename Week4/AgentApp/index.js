import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { DuckDuckGoSearch } from "@langchain/community/tools/duckduckgo_search";
import { TavilySearch } from "@langchain/tavily";
import { WikipediaQueryRun } from "@langchain/community/tools/wikipedia_query_run";
import { Pinecone } from "@pinecone-database/pinecone";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ChatBedrockConverse } from "@langchain/aws";

// import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { createAgent, tool } from "langchain";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import * as z from "zod";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config();


// Initialize a Pinecone client with your API key
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});
// Create a dense index with integrated embedding
const indexName = "policy-data-index";
// Target the index
const index = pc.index(indexName).namespace("policy-data-namespace");

//load pdf file
async function loadSinglePDF(filepath) {
  console.log(`Loading PDF: ${filepath}`);
  
  if (!fs.existsSync(filepath)) {
    throw new Error(`PDF file not found: ${filepath}`);
  }
  
  const loader = new PDFLoader(filepath);
  const docs = await loader.load();
  
  console.log(`Loaded PDF with ${docs.length} pages`);
  return docs;
}

const webSearchTool = new TavilySearch({
  maxResults: 5,
  apiKey: process.env.TAVILY_API_KEY,
  description: "Search the web for industry benchmarks, trends, regulatory updates, and current information. Use this for queries about hiring trends, compliance regulations, market data, and industry news."
});

const wikiTool = new WikipediaQueryRun({
  topKResults: 3,
  maxDocContentLength: 4000,
  description: "Search Wikipedia for general knowledge and established concepts"
});

const getWeather = tool(
  ({ location }) => `Weather in ${location}: Sunny, 72°F`,
  {
    name: "get_weather",
    description: "Get weather information for a location",
    schema: z.object({
      location: z.string().describe("The location to get weather for"),
    }),
  }
);

const getAqi = tool(
  ({ location }) => `AQI in ${location}: 42 (Good)`,
  {
    name: "get_aqi",
    description: "Get air quality index for a location",
    schema: z.object({
      location: z.string().describe("The location to get AQI for"),
    }),
  }
);

const rag_tool= tool(
    async ({ question }) => {
        const result= await index.searchRecords({
        query: {
          topK: 5,
          inputs: { text: question }
        }
      });
      console.log("RAG Search Results:", result);
      const pineconeContext = result.result.hits
        .map(h => h.fields.chunk_text)
        .join("\n");
      return `Context:\n${pineconeContext}`;
    },
    {
        name: "rag_tool",
        description: "Retrieve information from the company policy/HR policy data knowledge base for the company Suna Pana. Use this to answer questions about company policies, HR guidelines, benefits, leave policies, and workplace conduct.",
        schema: z.object({
          question: z.string().describe("The question to retrieve information for"),
        }),
    }

)

//Add data to Vector db
const add_data_to_rag= async() =>{
    function dynamicChunk(text, maxChars, overlap) {
      text = text.replace(/\s+/g, " ").trim();
    
      // Split by sentence boundaries
      const sentences = text.split(/(?<=[.!?])\s+/);
    
      const chunks = [];
      let buffer = "";
    
      for (const s of sentences) {
        if ((buffer + s).length <= maxChars) {
          buffer += " " + s;
        } else {
          chunks.push(buffer.trim());
          buffer = buffer.slice(-overlap) + " " + s;
        }
      }
    
      if (buffer.trim()) chunks.push(buffer.trim());
    
      return chunks;
    }
    
    
    const existingIndexes = await pc.listIndexes();
    
    if (!existingIndexes.indexes.some((i) => i.name === indexName)) {
      console.log("Creating Pinecone index...");
      await pc.createIndexForModel({
        name: indexName,
        cloud: "aws",
        region: "us-east-1",
        embed: {
          model: "llama-text-embed-v2",
          fieldMap: { text: "chunk_text" },
        },
        waitUntilReady: true,
      });
    } else {
      console.log("Index already exists, skipping creation.");
      return;
    }
    
    
    // Load documents from PDF
    const docs = await loadSinglePDF('pdfs/company_data.pdf');
    const full_document=docs.map(doc=>doc.pageContent).join("\n");
    console.log("Loaded Documents:", full_document);

    
    // Split into dynamic chunks
    const chunks = dynamicChunk(full_document, 80, 20);

    // Prepare records for upsert
    const records = chunks
      .map(c => c.trim())
      .filter(c => c.length > 0)
      .map((chunk, idx) => ({
        _id: `fact-${idx}`,
        chunk_text: chunk
      }));
    
    
    // Upsert the records into a namespace
    await index.upsertRecords(records);
    

}

//Adding data to RAG index, skips if the index already exists(for one time flow only to add information to vector db from pdf)
await add_data_to_rag();



//MCP client setup
class MCPGoogleDocsClient {
  constructor() {
    this.client = null;
    this.transport = null;
    this.tools = [];
  }

  async initialize() {
    console.log("Initializing MCP Google Docs client...");
    
    try {
      // Create transport to Google Docs MCP server
      this.transport = new StdioClientTransport({
        command: "node",
        args: ["/Users/subramaniyans/Desktop/Ai_training/Mcp/mcp-googledocs-server/dist/server.js"],
         env: {
            GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
        }
        // Note: You might need to use @modelcontextprotocol/server-google-docs if available
        // Or use Google Drive server which can access Docs
      });

      // Create MCP client
      this.client = new Client(
        {
          name: "presidio-insurance-agent",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      // Connect to the server
      await this.client.connect(this.transport);
      
      // Get available tools
      const toolsResponse = await this.client.listTools();
      this.tools = toolsResponse.tools;
      
      console.log("MCP Google Docs client connected!");
      
    } catch (error) {
      console.error("Failed to initialize MCP client:", error.message);
      this.client = null;
    }
  }

  async callTool(toolName, args) {
    if (!this.client) {
      throw new Error("MCP client not initialized");
    }

    const response = await this.client.callTool({
      name: toolName,
      arguments: args,
    });

    // Extract text content from response
    return response.content
      .filter(item => item.type === "text")
      .map(item => item.text)
      .join("\n");
  }

  async close() {
    if (this.client) {
      await this.client.close();
    }
  }

  getTools() {
    return this.tools;
  }
}


//create mcp tool for gdocs
function createMCPGoogleDocsTool(mcpClient) {
  return tool(
    async ({ documentId }) => {
      console.log(`🔍 MCP Google Docs Search: "${documentId}"`);

      try {
        // Try to use the search tool from MCP server
        const searchTool = mcpClient.getTools().find(t => 
          t.name.includes("readGoogleDoc")
        );
        
        if (!searchTool) {
          return "Google Docs MCP tool not available. Please check MCP server connection.";
        }

        const result = await mcpClient.callTool(searchTool.name, { documentId });
        console.log(`Found results from Google Docs ${searchTool.name}: ${result}`);
        
        return `Google Docs Search Results:\n\n${result}`;
        
      } catch (error) {
        console.error(` MCP Error: ${error.message}`);
        return `Error searching Google Docs: ${error.message}`;
      }
    },
    {
      name: "google_docs_search",
      description: "Read Google Docs for insurance-related documents and information for Suna Pana Tech using document id. Use this to find insurance policies, claims documentation, underwriting guidelines, and customer case files stored in Google Docs.",
      schema: z.object({
        documentId: z.string().describe("document Id for Google Docs (e.g., '1NK5FJC2-YEgfZw_5tgOtcvTwj0sxhvvH')"),
      }),
    }
  );
}

const mcpClient = new MCPGoogleDocsClient();
await mcpClient.initialize();


const tools=[getWeather,getAqi, wikiTool,webSearchTool, rag_tool]

// Add MCP tool if client initialized successfully
if (mcpClient.client) {
    const googleDocsTool = createMCPGoogleDocsTool(mcpClient);
    tools.push(googleDocsTool);
    console.log("Added MCP Google Docs tool to agent tools.");
}



//model creation and agent creation
// const model = new ChatGoogleGenerativeAI({
//   model: "gemini-2.5-flash-tts",
//   apiKey: process.env.GEMINI_API_KEY,
// });

const model= new ChatBedrockConverse({
    modelName: "anthropic.claude-3-5-sonnet-20240620-v1:0",
    region: "us-east-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const agent = createAgent({
  model: model,
  tools: tools,
});


const response = await agent.invoke({
  messages: [{ role: "user", content: "What is the scope for IT industry in New York? do a web search and provide current information." }],
});
console.log("Full Response:", response);
const finalMessage = response.messages[response.messages.length - 1];
console.log("Answer:", finalMessage.content);


//From file with document id 1GVEhQMmaAXZMJ29nmh_tLf5nsUHWgc_K2VtJZO8ZasI in google docs, get the insurance details for company suna pana tech

//what is the leave policy at Suna Pana Tech?

//What is the scope for IT industry in New York? do a web search and provide current information.





