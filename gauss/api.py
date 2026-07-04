import os
import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from gauss.config import OPENAI_API_KEY, OPENAI_API_BASE
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage

app = FastAPI(title="Gauss Financial Agent API")

class StudyRequest(BaseModel):
    pool_address: str
    limit: Optional[int] = 4

@app.post("/integrate/meridian")
async def integrate_meridian(req: StudyRequest):
    """
    Integrates Gauss intelligence to analyze Meridian DLMM LPer data.
    """
    meridian_api = "https://api.agentmeridian.xyz/api"
    headers = {
        "x-api-key": "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz"
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            # Fetch LPer info
            lp_res = await client.get(f"{meridian_api}/top-lp/{req.pool_address}", headers=headers)
            study_res = await client.get(f"{meridian_api}/study-top-lp/{req.pool_address}", headers=headers)
            
            if lp_res.status_code != 200:
                raise HTTPException(status_code=lp_res.status_code, detail=f"Failed to fetch top LPs from Meridian API: {lp_res.text}")
            
            lp_data = lp_res.json()
            study_data = study_res.json() if study_res.status_code == 200 else {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Meridian connection error: {str(e)}")

    # 2. Feed to Gauss LLM for Technical Analysis & LP Profile recommendation
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="Gauss OpenAI Key is missing")

    llm = ChatOpenAI(
        model="gemini-3.5",
        openai_api_key=OPENAI_API_KEY,
        openai_api_base=OPENAI_API_BASE,
        temperature=0.2
    )

    # Extract safely
    overview = lp_data.get('overview') or {}
    pool_name = overview.get('name', 'Unknown')
    top_lpers = lp_data.get('topLpers') or []

    prompt = f"""
    You are Gauss. Analyze this Solana DLMM pool LP structure.
    Pool: {req.pool_address}
    Name: {pool_name}
    
    LPer Data:
    {top_lpers[:req.limit]}
    
    Study Insights:
    {study_data}
    
    Provide an ultra-terse trading recommendation:
    1. Should we deploy liquidity here? (Yes/No)
    2. Recommended Range Strategy (Spot/Curve/Bid-Ask) and Bin Width.
    3. Key Risk Factors.
    """

    try:
        response = llm.invoke([
            SystemMessage(content="You are Gauss, a professional finance and Solana LP trading quantitative agent."),
            HumanMessage(content=prompt)
        ])
        analysis = response.content
    except Exception as e:
        analysis = f"Error during Gauss LLM analysis: {str(e)}"

    return {
        "pool": req.pool_address,
        "pool_name": pool_name,
        "gauss_recommendation": analysis,
        "raw_lpers": top_lpers[:req.limit]
    }
