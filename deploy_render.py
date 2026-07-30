import urllib.request
import json

SERVICE_ID = "srv-d9kbefpt0dsc739c5ieg"
API_KEY = "rnd_DiPOW3slxcVBpycqIZvdFOdBk5NW"

url = f"https://api.render.com/v1/services/{SERVICE_ID}/deploys"
headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

data = json.dumps({}).encode('utf-8')
req = urllib.request.Request(url, data=data, headers=headers, method='POST')
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode('utf-8')
        print("Deploy triggered!")
        print(body[:500])
except Exception as e:
    print(f"Error: {e}")
