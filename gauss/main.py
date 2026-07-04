import sys
from typing import Literal, TypedDict
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import StateGraph, START, END
from gauss.config import OPENAI_API_KEY, OPENAI_API_BASE
from gauss.tools import get_stock_price

class AgentState(TypedDict):
    messages: list
    symbol: str
    price_info: str
    analysis: str

def fetch_data_node(state: AgentState) -> dict:
    symbol = state.get("symbol", "AAPL")
    price_info = get_stock_price(symbol)
    return {"price_info": price_info}

def analyze_node(state: AgentState) -> dict:
    if not OPENAI_API_KEY:
        return {"analysis": "Missing API key. Cannot analyze."}
    
    llm = ChatOpenAI(
        model="gemini-3.5",
        openai_api_key=OPENAI_API_KEY,
        openai_api_base=OPENAI_API_BASE,
        temperature=0.2
    )
    
    price_info = state.get("price_info", "")
    prompt = f"Analyze this price state and give key technical context (ultra-terse): {price_info}"
    
    response = llm.invoke([
        SystemMessage(content="You are Gauss, a finance and trading intelligence agent."),
        HumanMessage(content=prompt)
    ])
    
    return {"analysis": response.content}

# Build graph
workflow = StateGraph(AgentState)
workflow.add_node("fetch_data", fetch_data_node)
workflow.add_node("analyze", analyze_node)

workflow.add_edge(START, "fetch_data")
workflow.add_edge("fetch_data", "analyze")
workflow.add_edge("analyze", END)

app = workflow.compile()

def main():
    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    print(f"Running Gauss for {symbol}...")
    res = app.invoke({"symbol": symbol})
    print(f"Price: {res.get('price_info')}")
    print(f"Analysis: {res.get('analysis')}")

if __name__ == "__main__":
    main()
