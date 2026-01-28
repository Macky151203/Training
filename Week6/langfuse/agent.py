import time
from dotenv import load_dotenv

from langchain_aws import ChatBedrockConverse
from langchain.prompts import ChatPromptTemplate
from langchain.agents import create_tool_calling_agent, AgentExecutor
from langchain.tools import tool
from langchain_community.tools import WikipediaQueryRun
from langchain_community.utilities import WikipediaAPIWrapper
from langchain_community.tools.tavily_search import TavilySearchResults
from langfuse import get_client
from langfuse.langchain import CallbackHandler
from nemoguardrails import LLMRails, RailsConfig

from langchain.evaluation import load_evaluator, EvaluatorType


load_dotenv()


llm = ChatBedrockConverse(
    model_id="anthropic.claude-3-5-sonnet-20240620-v1:0"
)

langfuse = get_client()
langfuse_handler = CallbackHandler()


rails_config = RailsConfig.from_path("./guardrails")
rails = LLMRails(rails_config)


def guarded_invoke(user_input: str):
    """
    Guardrails runs for policy processing (side effects).
    Agent execution is always gated in application logic.
    """
    rails_output=rails.generate(messages=[{"role": "user", "content": user_input}])
    print("Guardrails Output:", rails_output)
    return agent_executor.invoke(
        {"input": user_input},
        config={"callbacks": [langfuse_handler]}
    )

tavily_search_results_json = TavilySearchResults(
    max_results=5,
    topic="general",
)

@tool
def add_numbers(a: int, b: int) -> int:
    """Add two numbers and return the result."""
    return a + b


@tool
def wikitool(query: str) -> str:
    """Search Wikipedia and return a summary."""
    wikipedia = WikipediaQueryRun(api_wrapper=WikipediaAPIWrapper())
    return wikipedia.run(query)

prompt = ChatPromptTemplate.from_messages([
    ("system",
     "You are a helpful assistant. "
     "Use tools when appropriate to answer the question."),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}")
])


agent = create_tool_calling_agent(
    llm=llm,
    tools=[add_numbers, wikitool, tavily_search_results_json],
    prompt=prompt
)

agent_executor = AgentExecutor(
    agent=agent,
    tools=[add_numbers, wikitool, tavily_search_results_json],
    verbose=True,
    return_intermediate_steps=True
)


qa_evaluator = load_evaluator(
    EvaluatorType.QA,
    llm=llm
)


#trial
expected_trajectories = {
    "What is 42 + 58?": ["add_numbers"],
    "Who is Mahendra Singh Dhoni?": ["wikitool"],
}

def extract_trajectory(response):
    trajectory = []
    for step in response.get("intermediate_steps", []):
        action, _ = step
        if hasattr(action, "tool"):
            trajectory.append(action.tool)
    return trajectory


evaluation_cases = [
    # {
    #     "input": "What is 42 + 58?",
    #     "reference": "100",
    #     "expected_tools": ["add_numbers"]
    # },
    {
        "input": "Who is Mahendra Singh Dhoni?",
        "reference": "Mahendra Singh Dhoni is an Indian former international cricketer",
        "expected_tools": ["wikitool","tavily_search_results_json"]
    },
    # {
    #     "input": "What is the latest news about OpenAI?",
    #     "reference": "OpenAI",
    #     "expected_tools": ["tavily_search_results_json","wikitool"]
    # }
]

def extract_tool_trajectory(response):
    tools_used = []
    for step in response.get("intermediate_steps", []):
        action, _ = step
        if hasattr(action, "tool"):
            tools_used.append(action.tool)
    return tools_used


def trajectory_match_score(expected, actual):
    if not expected:
        return 1.0 if not actual else 0.0
    matched = sum(1 for t in expected if t in actual)
    return matched / len(expected)

def run_agent_evaluation():
    results = []

    for case in evaluation_cases:
        start = time.time()

        response = guarded_invoke(case["input"])
        
        latency = time.time() - start

        output_text = response["output"][0]["text"]

        qa_result = qa_evaluator.evaluate_strings(
            input=case["input"],
            prediction=output_text,
            reference=case["reference"]
        )

        actual_tools = extract_tool_trajectory(response)
        traj_score = trajectory_match_score(
            case["expected_tools"],
            actual_tools
        )

        results.append({
            "input": case["input"],
            "output": output_text,
            "reference": case["reference"],
            "correctness": qa_result["score"],
            "latency": latency,
            "expected_tools": case["expected_tools"],
            "actual_tools": actual_tools,
            "trajectory_match": traj_score
        })

    return results

def write_markdown_report(results):
    with open("evaluation_report.md", "w") as f:
        f.write("# LangChain Agent Evaluation Report\n\n")

        for r in results:
            f.write(f"## Input\n{r['input']}\n\n")
            f.write(f"**Output:**\n{r['output']}\n\n")
            f.write(f"**Reference:**\n{r['reference']}\n\n")
            f.write(f"- Correctness Score: {r['correctness']}\n")
            f.write(f"- Latency: {r['latency']:.2f} seconds\n")
            f.write(f"- Expected Tools: {r['expected_tools']}\n")
            f.write(f"- Actual Tools: {r['actual_tools']}\n")
            f.write(f"- Trajectory Match Score: {r['trajectory_match']}\n\n")


results = run_agent_evaluation()
write_markdown_report(results)
