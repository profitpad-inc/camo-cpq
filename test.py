import re
import uuid
import requests


def find_download_id(html):
  """
  Locate the quote id, which doubles as the download id, in the page's
  <meta id="cpq-theme-error-config" ... data-quote-id="..."> tag.
  """
  match = re.search(r'data-quote-id="([0-9a-f]{32})"', html, re.I)
  if match:
    return match.group(1)

  # Fallback: any bare 32-char hex string that shows up near the word
  # "download" or "quote" somewhere in the page.
  for m in re.finditer(r'[0-9a-f]{32}', html, re.I):
    window = html[max(0, m.start() - 80): m.end() + 80]
    if re.search(r'download|quote', window, re.I):
      return m.group(0)

  return None


def download_quote_pdf(public_link, download_id=None):
  """
  Downloads a HubSpot public quote PDF in two hops, entirely in memory:
    1. GET the meta endpoint with (downloadId, portalId, sessionId) -> JSON
       with a short-lived signed CDN url.
    2. GET that signed url -> the PDF bytes.

  portalId is parsed from the hs-sites.com subdomain. sessionId is a
  client-generated UUID (not an auth token, just a tracking id). downloadId
  has to come from the page itself - pass it explicitly if auto-detection
  fails.
  """
  portal_match = re.search(r'https://(\d+)\.hs-sites\.com', public_link)
  if not portal_match:
    print("Couldn't parse a portalId out of the link - expected a "
          "https://{portalId}.hs-sites.com/... URL.")
    return None, None
  portal_id = portal_match.group(1)

  session = requests.Session()
  session.headers.update({"User-Agent": "Mozilla/5.0"})

  page = session.get(public_link)
  print(f'  quote page: {page.status_code}')
  if page.status_code != 200:
    print(f"Error loading quote page: {page.text[:300]}")
    return None, None

  if not download_id:
    download_id = find_download_id(page.text)
  if not download_id:
    print("Couldn't auto-find the download id. Inspect page.text for")
    print("'data-quote-id', then re-run with download_id='...' passed in.")
    return None, None
  print(f'  download id: {download_id}')

  session_id = str(uuid.uuid4())
  meta_url = (
    f"https://app.hubspot.com/api/inbounddbquotes/quotes/public/v1/downloads/"
    f"{download_id}/download?portalId={portal_id}&sessionId={session_id}"
  )

  meta_resp = session.get(meta_url, headers={
    "accept": "*/*",
    "origin": f"https://{portal_id}.hs-sites.com",
    "referer": public_link,
  })
  print(f'  quote download meta: {meta_resp.status_code}')
  if meta_resp.status_code != 200:
    print(f"Error getting signed link: {meta_resp.text[:300]}")
    if meta_resp.status_code in (401, 403):
      print("A 401/403 here would suggest this endpoint needs an authenticated")
      print("HubSpot session after all - worth checking if the quote link still")
      print("downloads for someone who was never logged into HubSpot.")
    return None, None

  meta = meta_resp.json()
  print("  meta response:", meta)

  pdf_url = meta.get("url") or meta.get("downloadUrl") or meta.get("signedUrl")
  if not pdf_url:
    print("Meta response didn't have a recognizable url field - check the")
    print("printed meta response above for the actual key name and adjust.")
    return None, None

  pdf_resp = session.get(pdf_url)
  print(f'  quote pdf: {pdf_resp.status_code}')
  if pdf_resp.status_code != 200 or not pdf_resp.content.startswith(b"%PDF"):
    print("Downloaded file was not a PDF.")
    return None, None

  filename_match = re.search(r'/([^/?]+\.pdf)', pdf_url)
  filename = filename_match.group(1) if filename_match else "quote.pdf"
  return pdf_resp.content, filename


link = "https://51458497.hs-sites.com/siz6x493igdz"
pdf_content, filename = download_quote_pdf(link)
if pdf_content:
  print(f"Got {filename}: {len(pdf_content)} bytes (in-memory, not written to disk)")
  # pdf_content is raw PDF bytes - hand it off to whatever's next
  # (upload, email attachment, etc.) without ever touching the filesystem.
  
output = {
  "filename": filename,
  # "pdf_content": pdf_content,
}


print(output)

if pdf_content:
  with open(filename, "wb") as f:
    f.write(pdf_content)
  print(f"Saved: {filename}")