# Amazon Bedrock and Polly: setup (about 20 minutes)

This turns on two Amazon services in DocSaathi:

- **The brain: Claude on Amazon Bedrock** understands what the family says and picks DocSaathi's tools.
  Claude Haiku 5.5 answers first. Claude Haiku 4.5 is its backup (every AWS account can use it).
- **The voice: Amazon Polly "Kajal"** speaks Alexa's answers in Hindi and Indian English.

DocSaathi works without them too: Groq or the built-in rules understand, and the browser speaks.
And if Amazon cannot answer later (no access yet, slow network, daily limit reached), the next one takes over
by itself: Claude Haiku 5.5 → Claude Haiku 4.5 → Groq → the built-in rules, and Polly → the browser voice.

> **Keys are secret.** Put them only in the `.env` file. Never paste them in a chat, an email, a screenshot,
> the video or GitHub. `.env` is in `.gitignore`, so git never uploads it.

`.env` needs `BRAIN=bedrock`, `VOICE=polly` and `AWS_REGION=us-east-1`: Mumbai (ap-south-1) offers neither Claude nor the Kajal voice.
If AWS says Claude is "not available for this account", set `BEDROCK_MODELS=off`: the brain is then `openai.gpt-oss-120b` on Bedrock
(the same key and permission).
(Copying from `.env.example`? Set those three lines yourself.)

---

## Step 1. Sign in (2 minutes)

1. Open <https://console.aws.amazon.com> and sign in with your AWS email (the root user).
   If the page hangs, connect the PC to your phone's hotspot and try again.
2. At the top right, pick the region **US East (N. Virginia) us-east-1**.

## Step 2. A spending alert (2 minutes)

1. Type **Budgets** in the search bar at the top and open it. Click **Create budget**.
2. Choose **Use a template**, then **Zero spend budget**. Enter your email and click **Create budget**.

AWS now emails you if any real money is charged. Your AWS credits (if you have them) are used first:
see them under **Billing and Cost Management → Credits**.

## Step 3. A key just for DocSaathi (8 minutes)

You make a separate AWS user that can **only** use Claude and Polly. If its key ever leaks, it can do nothing else,
and you delete it with one click.

1. Type **IAM** in the search bar and open it. Click **Users** (left), then **Create user**.
2. User name: `docsaathi`. Leave "Provide user access to the AWS Management Console" **unticked**. Click **Next**.
3. Choose **Attach policies directly**, then click **Create policy**. A new browser tab opens.
4. In the new tab click **JSON**, delete everything in the box, and paste this:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "ClaudeOnBedrock",
         "Effect": "Allow",
         "Action": "bedrock-mantle:CreateInference",
         "Resource": "*"
       },
       {
         "Sid": "PollyVoice",
         "Effect": "Allow",
         "Action": ["polly:SynthesizeSpeech", "polly:DescribeVoices"],
         "Resource": "*"
       }
     ]
   }
   ```

5. Click **Next**. Policy name: `DocSaathiBedrockPolly`. Click **Create policy**, then close that tab.
6. Back in the first tab, click the refresh button (↻), type `DocSaathi` in the search box, tick
   **DocSaathiBedrockPolly**, click **Next**, then **Create user**.
7. Click the new user **docsaathi**, open the **Security credentials** tab, and click **Create access key**.
8. Choose **Application running outside AWS**, click **Next**, then **Create access key**.
9. Click **Download .csv file**. AWS shows the secret key only once. Keep the file somewhere private,
   **not** inside the project folder.

## Step 4. Paste the two keys (1 minute)

Open `.env` (in `C:\xampp\htdocs\hackathon`) in VS Code and fill in the two lines from the .csv file:

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

No spaces and no quotes. Save the file.

## Step 5. Test (2 minutes)

In the VS Code terminal, inside the project folder:

```
npm run check:aws
```

It sends a few tiny test requests (well under one US cent). When everything works, it looks like this:

```
1. Keys in .env
  ✅ IAM access key found (works for Bedrock and Polly)

2. Claude on Amazon Bedrock (the brain)
  ✅ Claude Haiku 5.5: works (900 ms). It called find_doctors({"need":"dentist","patient":"Papa"})
  ✅ Claude Haiku 4.5: works (1200 ms). It called find_doctors({"need":"dentist","patient":"Papa"})

3. Amazon Polly (the voice)
  ✅ Kajal speaks Hindi (30 KB). Play it: C:\xampp\htdocs\hackathon\data\polly-check.mp3
```

Double-click that MP3 to hear Kajal. A ❌ line says what to do under it. More help is in [If something fails](#if-something-fails).
One ✅ model is enough to start: a model without access is skipped by itself.

## Step 6. Start DocSaathi (1 minute)

If DocSaathi is already running, stop it first (click its terminal and press **Ctrl+C**). Then:

```
npm start
```

Open <http://localhost:3000/alexa>. The bar at the top shows:

- **Brain: Amazon Bedrock (Claude Haiku 5.5) + Groq backup**
- **Voice: Amazon Polly (Kajal)**

Tap the mic and say *"Aarav ko bukhaar hai, bachchon ka doctor chahiye"*. Kajal answers. Try **Hindi mein bolo** too.

## Step 7 (optional). An accuracy score with Claude (3 minutes)

```
npm run eval:bedrock
```

It says 33 test sentences to Alexa (a few US cents) and writes `docs/eval-bedrock.md`, including which AI
answered each sentence. Its score can go into the README's **Accuracy** table.

---

## What it costs

| Service | Price | Daily limit in `.env` | The most one day can cost |
|---|---|---|---|
| Claude Haiku 5.5 | $0.10 per million tokens (word pieces) in, $0.50 out | `BEDROCK_DAILY_LIMIT=500` requests | about $0.20 |
| Claude Haiku 4.5 (only while 5.5 has no access) | $1 in, $5 out | the same 500 requests | about $1.50 |
| Polly, Kajal neural voice | about $16 per million characters | `POLLY_DAILY_CHARS=60000` | about $1 |

One answer to the family uses about 1 to 3 requests. A normal day of testing (around 100 answers) costs
**under 10 US cents for Claude** and **about 25 US cents for Polly**. An answer Kajal already spoke once comes from
`data/voice-cache` for free. The day's counts are kept in `data/aws-usage.json`, so restarting DocSaathi does not
reset them. When a limit is reached, Groq or the rules answer and the browser speaks, until 5:30 AM India time
(midnight UTC). To spend even less, lower the two limits in `.env` (for example 200 and 20000).

Prices are AWS list prices in October 2026. Your bill shows the exact amounts.

## If something fails

| `npm run check:aws` says | What to do |
|---|---|
| No AWS key found | Paste both keys into `.env` (Step 4) and save the file. |
| AWS did not accept the key | Copy both keys again from the .csv file (no spaces), save `.env`, run the check again. |
| Claude Haiku 5.5: no access yet | Normal for a new account; Haiku 4.5 answers meanwhile. In the AWS console (Mumbai), open **Amazon Bedrock**, find **Claude Haiku 5.5** under **Model access** or the **Model catalog**, and request access. Fill in the short use-case form if it asks. Wait a few minutes and run the check again. |
| No access for both models | Do the same for **Claude Haiku 4.5**. Check that Step 3 attached the policy. To see whether it is the model or the key: in Bedrock, open **Playgrounds → Chat**, pick the model, and type "hi". If it still says no, look under **Billing** at your account plan: some partner models (like Claude) may not be open on the AWS Free plan. Groq keeps answering meanwhile. |
| Not available in ap-south-1 | Set `AWS_REGION=us-east-1` in `.env` and run the check again. |
| Too many requests | New AWS accounts start with low limits. Wait a minute and try again. |
| Could not reach Bedrock / Polly | Your internet blocks some AWS addresses. Connect the PC to your phone hotspot and try again. |
| Polly did not accept the key | The policy needs `polly:SynthesizeSpeech` and `polly:DescribeVoices` (Step 3). |
| Kajal is not offered, or has no neural engine | Set `POLLY_REGION=us-east-1` in `.env` and run the check again. |

While DocSaathi runs, its terminal prints a line starting with `[bedrock]` or `[voice]` when it switches to a backup,
and why.

## Keep it safe

- **A key leaked?** IAM → Users → docsaathi → Security credentials → **Deactivate**, then **Delete** the key.
  Make a new one (Step 3, from point 7).
- **After the hackathon:** delete the access key, or the whole `docsaathi` user, so nothing can be charged.
- **A step was confusing or broke?** Write down what happened (a screenshot without keys is fine).
  It goes into [FRICTION_LOG.md](FRICTION_LOG.md), which can earn bonus points.
