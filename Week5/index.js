import { ChatBedrockConverse } from "@langchain/aws";
import { TavilySearch } from "@langchain/tavily";
import { StateGraph, END } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import * as z from "zod";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config();


const model = new ChatBedrockConverse({
  modelName: "anthropic.claude-3-5-sonnet-20240620-v1:0",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});


//Read IT Docs
const readITDocs = tool(
  async ({ query }) => {
    console.log(`Reading IT docs for: "${query}"`);
    const content = fs.readFileSync("data/itdata.txt", "utf8");
    return content;
  },
  {
    name: "read_it_docs",
    description: "Read internal IT documentation for VPN setup, approved software, laptop requests, and IT policies. Use this for internal company IT information.",
    schema: z.object({
      query: z.string().describe("What to search for in IT docs"),
    }),
  }
);

//Read Finance Docs
const readFinanceDocs = tool(
  async ({ query }) => {
    console.log(`Reading Finance docs for: "${query}"`);
    const content = fs.readFileSync("data/financedata.txt", "utf8");
    return content;
  },
  {
    name: "read_finance_docs",
    description: "Read internal finance documentation for reimbursements, budget reports, payroll, and expense policies. Use this for internal company finance information.",
    schema: z.object({
      query: z.string().describe("What to search for in Finance docs"),
    }),
  }
);

//Tavily Web Search
const tavilySearch = new TavilySearch({
  maxResults: 5,
  apiKey: process.env.TAVILY_API_KEY,
});

const webSearchTool = tool(
  async ({ query }) => {
    console.log(`Tavily web search for: "${query}"`);
    try {
      const results = await tavilySearch.invoke(query);
      // Tavily returns JSON, convert to readable text
      if (typeof results === 'string') {
        return results;
      } else {
        // Parse JSON results into readable format
        const parsed = JSON.parse(results);
        if (Array.isArray(parsed)) {
          return parsed.map((r, i) => 
            `${i + 1}. ${r.title || 'Result'}\n   ${r.content || r.snippet || ''}\n   URL: ${r.url || ''}`
          ).join('\n\n');
        }
        return JSON.stringify(parsed, null, 2);
      }
    } catch (error) {
      console.error(`Tavily search error: ${error.message}`);
      return `Web search failed: ${error.message}`;
    }
  },
  {
    name: "web_search",
    description: "Search the web using Tavily for external information, industry standards, best practices, regulations, or public data. Use this when internal documentation is insufficient or when you need current industry information.",
    schema: z.object({
      query: z.string().describe("Search query for the web (e.g., 'latest VPN security practices', 'tax regulations 2025')"),
    }),
  }
);



const all_tools = [readITDocs, readFinanceDocs, webSearchTool];


const AgentState = {
  messages: {
    value: (x, y) => x.concat(y),
    default: () => [],
  },
  next: {
    value: (x, y) => y ?? x,
    default: () => "supervisor",
  },
};

//supervisor agent
async function supervisorAgent(state) {
  console.log("\n🎯 Supervisor Agent: Analyzing query...");
  
  const lastMessage = state.messages[state.messages.length - 1];
  const userQuery = lastMessage.content;
  
  const supervisorPrompt = `You are a supervisor agent that routes queries to the correct department.

User Query: "${userQuery}"

Analyze this query and determine which department should handle it:
- "IT" - for IT-related queries (VPN, software, laptops, technical issues)
- "Finance" - for finance-related queries (reimbursements, budgets, payroll, expenses)
- "DONE" - if the query doesn't fit IT or Finance

Respond with ONLY one word: IT, Finance, or DONE`;

  const response = await model.invoke([new HumanMessage(supervisorPrompt)]);
  const decision = response.content.trim().toUpperCase();
  
  console.log(`Decision: Route to ${decision}`);
  
  let next;
  if (decision.includes("IT")) {
    next = "it_agent";
  } else if (decision.includes("FINANCE")) {
    next = "finance_agent";
  } else {
    next = "end";
  }
  
  return {
    messages: state.messages,
    next: next,
  };
}

// it agent with tool calling
async function itAgent(state) {
  console.log("\nIT Agent: Processing query with tools...");
  
  const lastMessage = state.messages[state.messages.length - 1];
  const userQuery = lastMessage.content;
  
  // Bind tools to the model
  const modelWithTools = model.bindTools(all_tools);
  
  // Initial prompt
  const systemPrompt = `You are an IT support specialist. You have access to three tools:
1. read_it_docs - Read internal IT documentation (company-specific IT policies, VPN setup, approved software)
2. read_finance_docs - Read internal finance documentation (usually not needed for IT queries)
3. web_search - Search the web using Tavily for external information (industry best practices, security standards, latest updates)

Strategy:
- Start by checking internal IT documentation using read_it_docs
- Use web_search if you need external information, industry best practices, or latest updates
- Provide clear, actionable answers

User Question: ${userQuery}`;

  const messages = [
    new HumanMessage(systemPrompt),
  ];
  
  // Call model (may return tool calls)
  let response = await modelWithTools.invoke(messages);
  messages.push(response);
  
  // Handle tool calls iteratively
  let iterations = 0;
  const MAX_ITERATIONS = 5;
  
  while (response.tool_calls && response.tool_calls.length > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`Tool calls requested (iteration ${iterations}): ${response.tool_calls.map(tc => tc.name).join(", ")}`);
    
    // Execute each tool call
    for (const toolCall of response.tool_calls) {
      const tool = all_tools.find(t => t.name === toolCall.name);
      
      if (tool) {
        try {
          const toolResult = await tool.invoke(toolCall.args);
          messages.push(
            new ToolMessage({
              content: toolResult,
              tool_call_id: toolCall.id,
            })
          );
        } catch (error) {
          console.error(`Tool error (${toolCall.name}):`, error.message);
          messages.push(
            new ToolMessage({
              content: `Error executing ${toolCall.name}: ${error.message}`,
              tool_call_id: toolCall.id,
            })
          );
        }
      } else {
        console.error(`Tool not found: ${toolCall.name}`);
      }
    }
    
    // Get next response from model
    response = await modelWithTools.invoke(messages);
    messages.push(response);
  }
  
  console.log("IT Agent response generated");
  
  return {
    messages: [...state.messages, new AIMessage(response.content)],
    next: "end",
  };
}

//finance agent with tool calling
async function financeAgent(state) {
  console.log("Finance Agent: Processing query with tools...");
  
  const lastMessage = state.messages[state.messages.length - 1];
  const userQuery = lastMessage.content;
  
  // Bind tools to the model
  const modelWithTools = model.bindTools(all_tools);
  
  // Initial prompt
  const systemPrompt = `You are a Finance department assistant. You have access to three tools:
1. read_it_docs - Read internal IT documentation (usually not needed for finance queries)
2. read_finance_docs - Read internal finance documentation (reimbursements, budgets, payroll, expense policies)
3. web_search - Search the web using Tavily for external information (tax regulations, industry benchmarks, financial standards)

Strategy:
- Start by checking internal finance documentation using read_finance_docs
- Use web_search if you need external information like tax regulations or industry benchmarks
- Provide clear, actionable answers

User Question: ${userQuery}`;

  const messages = [
    new HumanMessage(systemPrompt),
  ];
  
  // Call model (may return tool calls)
  let response = await modelWithTools.invoke(messages);
  messages.push(response);
  
  // Handle tool calls iteratively
  let iterations = 0;
  const MAX_ITERATIONS = 5;
  
  while (response.tool_calls && response.tool_calls.length > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`Tool calls requested (iteration ${iterations}): ${response.tool_calls.map(tc => tc.name).join(", ")}`);
    
    // Execute each tool call
    for (const toolCall of response.tool_calls) {
      const tool = all_tools.find(t => t.name === toolCall.name);
      
      if (tool) {
        try {
          const toolResult = await tool.invoke(toolCall.args);
          messages.push(
            new ToolMessage({
              content: toolResult,
              tool_call_id: toolCall.id,
            })
          );
        } catch (error) {
          console.error(`Tool error (${toolCall.name}):`, error.message);
          messages.push(
            new ToolMessage({
              content: `Error executing ${toolCall.name}: ${error.message}`,
              tool_call_id: toolCall.id,
            })
          );
        }
      } else {
        console.error(`Tool not found: ${toolCall.name}`);
      }
    }
    
    // Get next response from model
    response = await modelWithTools.invoke(messages);
    messages.push(response);
  }
  
  console.log("Finance Agent response generated");
  
  return {
    messages: [...state.messages, new AIMessage(response.content)],
    next: "end",
  };
}

//graph workflow
function createWorkflow() {
  const workflow = new StateGraph({
    channels: AgentState,
  });

  // Add nodes
  workflow.addNode("supervisor", supervisorAgent);
  workflow.addNode("it_agent", itAgent);
  workflow.addNode("finance_agent", financeAgent);

  // Add edges
  workflow.addEdge("it_agent", END);
  workflow.addEdge("finance_agent", END);
  
  // Conditional edges from supervisor
  workflow.addConditionalEdges(
    "supervisor",
    (state) => state.next,
    {
      it_agent: "it_agent",
      finance_agent: "finance_agent",
      end: END,
    }
  );

  // Set entry point
  workflow.setEntryPoint("supervisor");

  return workflow.compile();
}

async function main() {
  console.log("\nMulti-Agent System with Tool Calling");
  console.log("=" .repeat(70));
  console.log("Agents: Supervisor → IT Agent | Finance Agent");
  console.log("Tools: read_it_docs, read_finance_docs, web_search (Tavily)");
  console.log("=" .repeat(70));

  const app = createWorkflow();

  // Test queries
  const testQueries = [
    // IT - should use read_it_docs
    "How do I set up the VPN?",
    
    // IT - should use read_it_docs + web_search
    "What are the latest cybersecurity best practices for VPN in 2025?",
    
    // Finance - should use read_finance_docs
    "How do I file a reimbursement?",
    
    // Finance - should use read_finance_docs + web_search
    "What are current tax regulations for employee expense reimbursements?",
  ];

  for (const query of testQueries) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`User Query: ${query}`);
    console.log("=".repeat(70));

    try {
      const result = await app.invoke({
        messages: [new HumanMessage(query)],
      });

      const finalMessage = result.messages[result.messages.length - 1];
      
      console.log("\nFinal Answer:");
      console.log("-".repeat(70));
      console.log(finalMessage.content);
      console.log("-".repeat(70));

    } catch (error) {
      console.error(`\nError: ${error.message}`);
      console.error(error.stack);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("All queries processed!");
  console.log("=".repeat(70));
}

main().catch(console.error);