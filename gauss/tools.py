import pandas as pd
import yfinance as yf

def get_stock_price(ticker: str, period: str = "1mo") -> str:
    """Fetch recent stock price data for a ticker."""
    try:
        stock = yf.Ticker(ticker)
        hist = stock.history(period=period)
        if hist.empty:
            return f"No data found for {ticker}."
        last_close = hist['Close'].iloc[-1]
        prev_close = hist['Close'].iloc[-2] if len(hist) > 1 else last_close
        pct_change = ((last_close - prev_close) / prev_close) * 100
        return f"{ticker}: {last_close:.2f} (Daily Change: {pct_change:+.2f}%)"
    except Exception as e:
        return f"Error fetching price for {ticker}: {str(e)}"
