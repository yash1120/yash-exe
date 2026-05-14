# Deploy Yash.exe for free

We'll use **Render** — free tier, no credit card, auto-HTTPS, gives you a `https://yash-exe.onrender.com` URL you can share.

> **Caveat:** the free tier **sleeps after 15 min of no traffic**. First call after sleep takes ~30s to wake up. Fine for a recruiter-facing demo; if it bugs you, see "Alternatives" at the bottom.

---

## One-time setup (5 minutes)

### 1. Push the project to GitHub

```powershell
cd F:\projects\yash-exe
git init
git add .
git commit -m "Initial commit: Yash.exe MVP"
gh repo create yash-exe --public --source=. --remote=origin --push
```

If you don't have the `gh` CLI: create an empty repo at https://github.com/new called `yash-exe`, then:
```powershell
git remote add origin https://github.com/yash1120/yash-exe.git
git branch -M main
git push -u origin main
```

### 2. Get your Groq key (if you haven't yet)

1. Go to https://console.groq.com/keys
2. Sign in with Google (no card needed)
3. **Create API Key** → copy the `gsk_...` string

### 3. Deploy on Render

1. Go to https://dashboard.render.com/ → **New** → **Blueprint**
2. Click **Connect GitHub**, authorize Render to read your repos
3. Pick the `yash-exe` repo → Render reads `render.yaml` and shows the plan
4. Click **Apply** — it starts building
5. While it builds, click into the service → **Environment** tab → find `GROQ_API_KEY` → click **Edit** → paste your key → **Save Changes**
6. Click **Manual Deploy** → **Deploy latest commit** (so it picks up the new env var)

After ~3 minutes, the service is live at `https://yash-exe.onrender.com` (or whatever Render assigns).

### 4. Test it

Open the URL. Click a suggestion chip, or tap the mic and ask: *"What did you build at AirLabOne?"*

You should hear a Sydney-accent voice reply.

---

## Make it yours

### Custom domain (optional, also free)
1. In Render → your service → **Settings** → **Custom Domains** → **Add**
2. Add e.g. `talk.yashgoyal.com`
3. Add the CNAME record Render gives you to your DNS provider
4. SSL auto-issues in ~2 min

### Change the voice
In Render → Environment → set `YASH_EXE_VOICE` to one of these and save:

| Voice | Vibe |
|---|---|
| `en-AU-WilliamNeural` | Sydney accent, professional (default) |
| `en-AU-NeilNeural` | Sydney accent, slightly older/deeper |
| `en-IN-PrabhatNeural` | Indian English |
| `en-US-BrianNeural` | American, casual confident |
| `en-US-AndrewNeural` | American, friendly |
| `en-GB-RyanNeural` | British |

Full list: `python -c "import edge_tts, asyncio; print('\n'.join(v['ShortName'] for v in asyncio.run(edge_tts.list_voices()) if v['Locale'].startswith('en')))"`

### Keep it from sleeping
A free trick: add an UptimeRobot monitor (uptimerobot.com — free) pinging `https://yash-exe.onrender.com/api/health` every 5 min. Keeps the dyno warm during business hours. *(Note: this technically violates Render's free-tier expectation; use sparingly or upgrade for $7/mo if recruiters will hit it often.)*

---

## Alternatives if Render doesn't suit

### Hugging Face Spaces — never sleeps, totally free
1. Create a Space at https://huggingface.co/new-space → SDK: **Docker**
2. `git remote add hf https://huggingface.co/spaces/<your-username>/yash-exe`
3. `git push hf main`
4. Add `GROQ_API_KEY` as a Secret in the Space settings
5. URL: `https://<your-username>-yash-exe.hf.space`

### Fly.io — never sleeps, free tier with 3 small VMs
```powershell
# Install: https://fly.io/docs/hands-on/install-flyctl/
flyctl launch --dockerfile Dockerfile --no-deploy
flyctl secrets set GROQ_API_KEY=gsk_your_key_here
flyctl deploy
```
URL: `https://yash-exe.fly.dev`

### Google Cloud Run — free tier ($300 signup credit, then mostly free for low traffic)
Uses the `Dockerfile`. See https://cloud.google.com/run/docs/quickstarts/deploy-container.

---

## Shipping checklist

- [ ] Site is live, you can chat and hear the reply
- [ ] Run `python -m evals.test_facts` locally — all 7 cases pass
- [ ] Edit `data/yash_profile.md` so the bio sounds like *you*, not me
- [ ] Add the URL to your LinkedIn headline: *"Don't read my CV — talk to it: yash-exe.onrender.com"*
- [ ] Record a 30-second screen capture of yourself using it, post on LinkedIn tagging companies you're targeting
- [ ] Add the URL to the **Projects** section of your CV with a one-liner
