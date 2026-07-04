import urllib.request
import urllib.parse
import re

query = urllib.parse.quote('mesin cuci terbaik dibawah 4 juta')
url = f'https://html.duckduckgo.com/html/?q={query}'
req = urllib.request.Request(
    url, 
    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
)
try:
    html = urllib.request.urlopen(req).read().decode('utf-8')
    
    # Extracting URLs that seem relevant to articles about washing machines
    # Looking for titles that suggest a list or recommendation of washing machines
    pattern = r'<a rel="nofollow" class="result__a" href="(//duckduckgo.com/l/\?uddg=https%3A%2F%2F[^"]+)"[^>]*>(.*?)<\/a>'
    matches = re.findall(pattern, html)
    
    found_urls = []
    for match in matches:
        # Decode the URL to get the actual target
        decoded_url = urllib.parse.unquote(match[0].replace('//duckduckgo.com/l/?uddg=', ''))
        title = match[1]
        
        # Simple keywords to filter relevant articles
        if any(keyword in title.lower() for keyword in ['mesin cuci', 'rekomendasi', 'terbaik']):
            if 'juta' in title.lower() or 'rp4' in title.lower(): # Ensure price relevance
                found_urls.append((title, decoded_url))
                
    if found_urls:
        print("Found relevant articles:")
        for i, (title, url) in enumerate(found_urls):
            print(f"{i+1}. {title}: {url}")
    else:
        print("No specific articles found.")
        
except Exception as e:
    print("Error:", e)
