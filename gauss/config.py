import os
from dotenv import load_dotenv

# Load env variables from root or local
load_dotenv()
load_dotenv("/home/dwizzy/dwizzyOS/.env")

# If 9Router or another custom provider is active, map it
OPENAI_API_BASE = os.getenv("OPENAI_API_BASE", "http://localhost:20128/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or os.getenv("NINEROUTER_KEY")


