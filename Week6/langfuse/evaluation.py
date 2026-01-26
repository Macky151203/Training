import time
from dotenv import load_dotenv
load_dotenv()

from langchain.evaluation import load_evaluator, EvaluatorType
from agent import agent_executor, guarded_invoke

# -----------------------------
# Test cases (allowed only)
# -----------------------------
test_cases = [
    {
        "input": "What is 10 + 5?",
        "expected": "15"
    },
    {
        "input": "Who is Mahendra Singh Dhoni?",
        "expected": "Indian"
    },
    {
        "input": "What is 42 + 58?",
        "expected": "100"
    }
]

# -----------------------------
# Evaluators
# -----------------------------
correctness_evaluator = load_evaluator(EvaluatorType.QA)

hallucination_evaluator = load_evaluator(
    EvaluatorType.CRITERIA,
    criteria="hallucination"
)

tool_usage_evaluator = load_evaluator(
    EvaluatorType.CRITERIA,
    criteria="uses tools correctly when required"
)

results = []

# -----------------------------
# Run evaluation
# -----------------------------
for case in test_cases:
    start = time.time()

    response = guarded_invoke(case["input"])
    output = response["output"]

    latency = time.time() - start

    correctness = correctness_evaluator.evaluate_strings(
        prediction=output,
        reference=case["expected"]
    )

    hallucination = hallucination_evaluator.evaluate_strings(
        prediction=output,
        input=case["input"]
    )

    tool_usage = tool_usage_evaluator.evaluate_strings(
        prediction=output,
        input=case["input"]
    )

    results.append({
        "input": case["input"],
        "expected": case["expected"],
        "output": output,
        "correctness": correctness["score"],
        "hallucination": hallucination["score"],
        "tool_usage": tool_usage["score"],
        "latency": latency
    })

# -----------------------------
# Write Markdown report
# -----------------------------
with open("evaluation_report.md", "w") as f:
    f.write("# LangChain Agent Evaluation Report\n\n")

    for r in results:
        f.write(f"## Input: {r['input']}\n")
        f.write(f"- Expected: {r['expected']}\n")
        f.write(f"- Output: {r['output']}\n")
        f.write(f"- Correctness Score: {r['correctness']}\n")
        f.write(f"- Hallucination Score: {r['hallucination']}\n")
        f.write(f"- Tool Usage Score: {r['tool_usage']}\n")
        f.write(f"- Latency: {r['latency']:.2f}s\n\n")
