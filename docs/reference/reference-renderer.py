#!/usr/bin/env python3
import json, os, html

ROOT = "/tmp/claude-0/-home-claude/d6eeaf98-1ccd-5e9c-bb8e-2d85f94f6014/scratchpad/pv"
PROJ = os.path.join(ROOT, "project")
os.makedirs(PROJ, exist_ok=True)

NAVY   = "#17395C"
CREAM  = "#F7F4ED"
SAGE   = "#56653C"
GOLD   = "#A08A4B"   # decoration only (3:1)
GOLDTX = "#7A6534"   # gold used as text on cream (5:1)
GOLDLT = "#C9A961"   # gold on navy
SLATE  = "#5A6B7D"
TINT   = "#E4E7DA"
RULE   = "#DED8C8"
CARDBD = "#E3DDCC"
NAVSUB = "#C8D2DC"
NAVFT  = "#A8BACA"

BOOK = "https://precisionvitalitynursing.md-hq.com/embedded/schedule.php"

FONTS = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
         'family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,600&amp;'
         'family=Jost:wght@300;400;500;600&amp;family=Parisienne&amp;display=swap">')

SERIF = "'Cormorant Garamond', Georgia, serif"

def e(s):
    return html.escape(s, quote=False)

def page(title, body):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{e(title)}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
{FONTS}
<style>
body {{ margin: 0; background: {CREAM}; font-family: 'Jost', system-ui, sans-serif; }}
a {{ color: {GOLDTX}; }}
a:hover {{ color: #5F4E28; }}
</style>
</helmet>
{body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1080,"height":1080}}}}'>
class Component extends DCLogic {{
  renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
"""

def kicker_block(text, color=SAGE, rule=GOLD):
    return f"""    <div>
      <div style="font-size: 15px; font-weight: 500; letter-spacing: 3.4px; text-transform: uppercase; color: {color};">{e(text)}</div>
      <div style="width: 64px; height: 2px; background: {rule}; margin-top: 18px;"></div>
    </div>"""

def footer_block():
    return f"""    <div>
      <div style="height: 1px; background: {RULE};"></div>
      <div style="margin-top: 20px; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 500; letter-spacing: 1.7px; text-transform: uppercase; color: {SAGE};">precision-vitality.com</span>
        <span style="font-size: 13px; font-weight: 400; letter-spacing: 1.7px; text-transform: uppercase; color: {SAGE};">Psychiatry · Cellular Medicine</span>
      </div>
    </div>"""


# ---------- slide 1: hook ----------
def hook(kicker, headline, script, photo):
    return f"""<div style="width: 1080px; height: 1080px; box-sizing: border-box; display: flex; background: {CREAM};">
  <div style="width: 626px; box-sizing: border-box; padding: 76px 52px 64px 72px; display: flex; flex-direction: column; justify-content: space-between;">
{kicker_block(kicker)}
    <div style="display: flex; flex-direction: column; gap: 30px;">
      <h1 style="margin: 0; font-family: {SERIF}; font-weight: 600; font-size: 78px; line-height: 1.02; letter-spacing: -0.5px; color: {NAVY};">{e(headline)}</h1>
      <p style="margin: 0; font-family: 'Parisienne', cursive; font-size: 42px; line-height: 1.3; color: {GOLDTX};">{e(script)}</p>
    </div>
    <div style="display: flex; align-items: center; gap: 14px;">
      <span style="font-size: 14px; font-weight: 500; letter-spacing: 2.8px; text-transform: uppercase; color: {SAGE};">Swipe</span>
      <svg width="36" height="10" viewBox="0 0 36 10" fill="none" aria-hidden="true"><path d="M0 5h33M29 1l5 4-5 4" stroke="{SAGE}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>
    </div>
  </div>
  <div style="flex-grow: 1; background: {TINT}; display: flex; align-items: center; justify-content: center; padding: 44px; box-sizing: border-box;">
    <div style="border: 1px dashed #9FAE87; padding: 30px 26px; text-align: center; font-size: 15px; font-weight: 400; line-height: 1.65; letter-spacing: 0.3px; color: {SAGE}; white-space: pre-line;">{e(photo)}<div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #C2CDB0; font-size: 13px; line-height: 1.5; white-space: normal;">Caption must state &#8220;model, not a patient.&#8221; Unlabeled stock imagery violates CA Bus &amp; Prof Code &#167;651(b)(3)(B).</div></div>
  </div>
</div>"""


# ---------- slide 2: what's behind it ----------
def cause(kicker, headline, sub, items):
    cells = []
    for label, text in items:
        cells.append(f"""        <div style="display: flex; gap: 14px;">
          <div style="width: 7px; height: 7px; border-radius: 50%; background: {GOLD}; margin-top: 11px; flex-shrink: 0;"></div>
          <div>
            <div style="font-size: 21px; font-weight: 500; line-height: 1.25; color: {NAVY};">{e(label)}</div>
            <div style="margin-top: 8px; font-size: 17px; font-weight: 400; line-height: 1.5; color: {SLATE};">{e(text)}</div>
          </div>
        </div>""")
    grid = "\n".join(cells)
    return f"""<div style="width: 1080px; height: 1080px; box-sizing: border-box; padding: 76px 72px 64px 72px; background: {CREAM}; display: flex; flex-direction: column; justify-content: space-between;">
{kicker_block(kicker)}
    <div style="display: flex; flex-direction: column; gap: 42px;">
      <div>
        <h1 style="margin: 0; font-family: {SERIF}; font-weight: 600; font-size: 58px; line-height: 1.08; letter-spacing: -0.4px; color: {NAVY};">{e(headline)}</h1>
        <p style="margin: 16px 0 0; font-size: 19px; font-weight: 400; line-height: 1.5; color: {SLATE}; max-width: 760px;">{e(sub)}</p>
      </div>
      <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 46px; row-gap: 34px;">
{grid}
      </div>
    </div>
{footer_block()}
</div>"""


# ---------- slide 3: what may help ----------
def protocol(kicker, headline, cards, disclaimer):
    cs = []
    for title, text in cards:
        cs.append(f"""        <div style="background: #FFFFFF; border: 1px solid {CARDBD}; border-radius: 4px; padding: 32px; display: flex; flex-direction: column; gap: 12px;">
          <div style="font-family: {SERIF}; font-weight: 600; font-size: 29px; line-height: 1.12; color: {NAVY};">{e(title)}</div>
          <div style="font-size: 16.5px; font-weight: 400; line-height: 1.55; color: {SLATE};">{e(text)}</div>
        </div>""")
    grid = "\n".join(cs)
    return f"""<div style="width: 1080px; height: 1080px; box-sizing: border-box; padding: 76px 72px 64px 72px; background: {CREAM}; display: flex; flex-direction: column; justify-content: space-between;">
{kicker_block(kicker)}
    <div style="display: flex; flex-direction: column; gap: 34px;">
      <h1 style="margin: 0; font-family: {SERIF}; font-weight: 600; font-size: 58px; line-height: 1.08; letter-spacing: -0.4px; color: {NAVY};">{e(headline)}</h1>
      <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 26px;">
{grid}
      </div>
      <p style="margin: 0; font-size: 13px; font-weight: 400; line-height: 1.55; color: {SLATE}; max-width: 880px;">{e(disclaimer)}</p>
    </div>
{footer_block()}
</div>"""


# ---------- slide 4: CTA ----------
def cta(kicker):
    points = [
        "Telehealth across California, plus in-person in Yorba Linda",
        "Diagnostics first — no protocol before labs",
        "Cash-pay practice. No insurance, no restrictions",
    ]
    ps = []
    for p in points:
        ps.append(f"""        <div style="display: flex; align-items: flex-start; gap: 14px;">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" style="margin-top: 4px; flex-shrink: 0;"><path d="M3 9.5l4 4L15 5" stroke="{GOLDLT}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>
          <span style="font-size: 18px; font-weight: 400; line-height: 1.45; color: {NAVSUB};">{e(p)}</span>
        </div>""")
    plist = "\n".join(ps)
    return f"""<div style="width: 1080px; height: 1080px; box-sizing: border-box; padding: 84px 80px 72px 80px; background: {NAVY}; display: flex; flex-direction: column; justify-content: space-between;">
{kicker_block(kicker, color=GOLDLT, rule=GOLDLT)}
    <div style="display: flex; flex-direction: column; gap: 28px;">
      <h1 style="margin: 0; font-family: {SERIF}; font-weight: 600; font-size: 74px; line-height: 1.04; letter-spacing: -0.6px; color: {CREAM};">Start with a free 15-minute consult.</h1>
      <p style="margin: 0; font-size: 20px; font-weight: 400; line-height: 1.55; color: {NAVSUB}; max-width: 780px;">A no-pressure conversation about your symptoms, your goals, and whether we are the right fit. No commitment, no cost.</p>
      <div style="display: flex; flex-direction: column; gap: 14px; margin-top: 6px;">
{plist}
      </div>
      <a href="{BOOK}" style="align-self: flex-start; margin-top: 14px; background: {GOLDLT}; color: {NAVY}; padding: 21px 46px; border-radius: 2px; font-size: 17px; font-weight: 500; letter-spacing: 2.4px; text-transform: uppercase; text-decoration: none;">Book a Consult</a>
    </div>
    <div>
      <div style="height: 1px; background: #2E5175;"></div>
      <div style="margin-top: 20px; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 500; letter-spacing: 1.7px; text-transform: uppercase; color: {NAVFT};">precision-vitality.com</span>
        <span style="font-size: 13px; font-weight: 400; letter-spacing: 1.7px; text-transform: uppercase; color: {NAVFT};">(714) 485-4573 · Yorba Linda, CA</span>
      </div>
    </div>
</div>"""


DISC_COMPOUND = ("Compounded medications are prepared per individual prescription and are not reviewed by the U.S. Food and Drug "
                 "Administration for safety or efficacy. These statements have not been evaluated by the FDA. Individual results vary. "
                 "Treatment is determined at evaluation and is not guaranteed.")
DISC_GENERAL = ("Care is individualized and begins with diagnostic testing. Treatment is determined at evaluation and is not guaranteed. "
                "Precision Vitality serves patients located in California. This is not medical advice.")

# ======================= CONTENT =======================

C = []

# --- 1: Fine lines ---
C.append(dict(
    slug="C1", title="1 · Fine Lines", kicker="Healthy Aging",
    hook=dict(
        headline="Fine lines showing up faster than they used to?",
        script="It is rarely just your skin.",
        photo="PHOTO PLACEHOLDER\n\nWoman, 40s. Natural window\nlight, hand resting at the jaw.\nNeutral knit, minimal makeup.",
    ),
    cause=dict(
        headline="Skin is an output. These are the inputs.",
        sub="Creams work on the surface. Most of what you are seeing is being driven a layer down.",
        items=[
            ("Declining estrogen & androgens", "Hormone shifts thin the dermis and slow collagen and elastin production."),
            ("Mitochondrial slowdown", "Less cellular energy means slower turnover and slower repair."),
            ("Chronic low-grade inflammation", "Inflammation degrades the collagen you already have."),
            ("Oxidative stress", "Sun, alcohol, stress and poor sleep accelerate cellular aging."),
            ("Nutrient absorption", "Gut issues limit the protein, zinc and vitamin C skin is built from."),
            ("Cortisol & sleep debt", "Overnight is when repair happens. Short sleep cancels it."),
        ],
    ),
    protocol=dict(
        headline="What we look at — and what may help",
        cards=[
            ("Start with data", "Hormone panel, thyroid, inflammatory markers and micronutrients. No protocol before labs."),
            ("Topical peptide therapy", "Formulas such as Stella+ — GHK-Cu, estriol, tretinoin and niacinamide — compounded per prescription when appropriate."),
            ("Cellular medicine", "Targeted support for mitochondrial function, oxidative stress and collagen and elastin production."),
            ("Foundations that compound", "Sleep, protein, gut health and professional-grade supplementation through Fullscript."),
        ],
        disclaimer=DISC_COMPOUND,
    ),
    caption=(
        "Fine lines are not only a skin problem.\n\n"
        "Collagen and elastin production is driven by your hormones, your mitochondria, your inflammatory load and how well "
        "you actually absorb nutrients. A topical works on the surface. We start one layer down — with labs.\n\n"
        "Every plan at Precision Vitality begins with diagnostics, never with a product.\n\n"
        "Comment SKIN and I will send you the panel we run before we recommend anything.\n\n"
        "Free 15-minute consult — link in bio. Telehealth across California, in-person in Yorba Linda.\n\n"
        "Images are models, not patients.\n\n"
        "#healthyaging #functionalmedicine #cellularmedicine #yorbalinda #rootcause"
    ),
))

# --- 2: Men's hormones ---
C.append(dict(
    slug="C2", title="2 · Men's Hormones", kicker="Men's Health",
    hook=dict(
        headline="Things not working like they used to?",
        script="Low T is only one of the answers.",
        photo="PHOTO PLACEHOLDER\n\nMan, 45–55. Outdoor golden\nhour, relaxed, looking\noff-camera. Not clinical.",
    ),
    cause=dict(
        headline="Six things we check before anyone says “low T”",
        sub="A single testosterone number is the most common reason men get the wrong plan.",
        items=[
            ("Total & free testosterone", "Total can look normal while free — the usable kind — is low."),
            ("Estradiol & SHBG", "Too much conversion, or too much binding, blunts the testosterone you already have."),
            ("Insulin resistance & visceral fat", "Abdominal fat raises estrogen and pushes testosterone down."),
            ("Sleep apnea & sleep debt", "Most testosterone is produced during deep sleep."),
            ("Thyroid", "Low thyroid mimics low testosterone almost symptom for symptom."),
            ("Medications & vascular health", "Blood pressure, blood sugar and several common prescriptions all affect performance."),
        ],
    ),
    protocol=dict(
        headline="What a real plan looks like",
        cards=[
            ("A full panel, not one number", "Total and free testosterone, SHBG, estradiol, LH, PSA, A1c, lipids, full thyroid, CBC and CMP."),
            ("Bioidentical hormone therapy", "Protocols dosed to your labs and your symptoms, with an aromatase inhibitor only when indicated."),
            ("Metabolic optimization", "Body composition, insulin and visceral fat move the same dial testosterone does."),
            ("Monitored, then adjusted", "Repeat labs, dose changes and ongoing management. Medication shipped to your door."),
        ],
        disclaimer=DISC_COMPOUND,
    ),
    caption=(
        "Most men get handed a testosterone number and a prescription. That skips the part that matters.\n\n"
        "Free testosterone, estradiol, SHBG, thyroid, insulin resistance, sleep — any one of them can produce the same "
        "symptoms, and treating the wrong one wastes months.\n\n"
        "We run the full panel first, then build the protocol around what it says.\n\n"
        "Comment PANEL and I will send you the full list of what we test before anyone talks about testosterone.\n\n"
        "Free 15-minute consult — link in bio. Telehealth across California, in-person in Yorba Linda.\n\n"
        "Images are models, not patients.\n\n"
        "#menshealth #testosterone #hormonehealth #yorbalinda #functionalmedicine"
    ),
))

# --- 3: Women / libido ---
C.append(dict(
    slug="C3", title="3 · Low Libido", kicker="Women's Health",
    hook=dict(
        headline="Never in the mood anymore?",
        script="You are not broken. You are depleted.",
        photo="PHOTO PLACEHOLDER\n\nWoman, 35–50. Soft morning\nlight, seated, quiet and\nunposed. Warm neutrals.",
    ),
    cause=dict(
        headline="Low libido is a symptom, not a diagnosis",
        sub="Desire is usually the first thing the body drops when something upstream is off. Six of the usual suspects:",
        items=[
            ("Thyroid", "Hypothyroidism flattens energy, mood and desire — and it is routinely missed."),
            ("Low ferritin & B12", "Hemoglobin can read normal while your iron stores are empty."),
            ("Cortisol & burnout", "The body deprioritizes libido when it believes you are under threat."),
            ("Perimenopausal shifts", "Estrogen and progesterone start moving years before periods change."),
            ("Antidepressants", "SSRIs and SNRIs are one of the most common — and most addressable — causes."),
            ("Blood sugar & sleep", "Glucose swings and short sleep hit desire before they hit anything else."),
        ],
    ),
    protocol=dict(
        headline="Where we start",
        cards=[
            ("A panel that actually looks", "Full thyroid, ferritin, estradiol, progesterone, DHEA-S, cortisol, A1c, B12 and vitamin D."),
            ("A medication review", "If your prescription is driving this, alternatives exist. That is a conversation worth having."),
            ("Gut-brain assessment", "GI-MAP testing when absorption, inflammation or mood symptoms point in that direction."),
            ("Nervous system support", "Referral to our functional partner for somatic and stress-regulation work when it fits."),
        ],
        disclaimer=DISC_GENERAL,
    ),
    caption=(
        "“I just don't have a drive anymore.” We hear it constantly, and it is almost never the whole story.\n\n"
        "Thyroid. Ferritin. Cortisol. Perimenopause. Blood sugar. The medication that helped your mood and quietly took "
        "something else with it. Low libido is the symptom sitting on top of all of it.\n\n"
        "It is worth testing before you decide this is just who you are now.\n\n"
        "Comment DRIVE and I will send you the full panel we run before anyone calls this normal.\n\n"
        "Free 15-minute consult — link in bio. Telehealth across California, in-person in Yorba Linda.\n\n"
        "Images are models, not patients.\n\n"
        "#womenshealth #perimenopause #thyroidhealth #yorbalinda #functionalmedicine"
    ),
))

# --- 4: Energy ---
C.append(dict(
    slug="C4", title="4 · Energy & Fatigue", kicker="Energy & Longevity",
    hook=dict(
        headline="Wrecked by 2pm. Wired at 11pm.",
        script="That is a pattern, not a personality.",
        photo="PHOTO PLACEHOLDER\n\nLate afternoon light on a\ndesk or kitchen counter.\nCoffee cup, hand at temple.",
    ),
    cause=dict(
        headline="When your energy curve flips",
        sub="Afternoon crashes and second winds at night usually point to something measurable.",
        items=[
            ("Cortisol rhythm", "It should peak in the morning and fall at night. Often it is doing the opposite."),
            ("Mitochondrial dysfunction", "Your cells produce less energy. Everything downstream feels it."),
            ("Blood sugar swings", "The 2pm crash usually starts with what happened at 8am."),
            ("Thyroid", "Subclinical hypothyroidism rarely shows up on a TSH-only panel."),
            ("Ferritin, B12 & vitamin D", "Three of the most common and most correctable deficiencies we find."),
            ("Chronic inflammation", "Inflammation is metabolically expensive. It costs you energy."),
        ],
    ),
    protocol=dict(
        headline="What may help",
        cards=[
            ("Diagnostics first", "Full thyroid, cortisol rhythm, ferritin, B12, vitamin D, A1c, lipids and inflammatory markers."),
            ("Cellular medicine", "Support aimed at mitochondrial function, cellular energy and oxidative stress, including NAD+ protocols."),
            ("Thyroid optimization", "Treated to the full panel and your symptoms, not to a single reference range."),
            ("Metabolic optimization", "Stabilize glucose, body composition and the inflammatory load driving the crash."),
        ],
        disclaimer=DISC_COMPOUND,
    ),
    caption=(
        "If you are exhausted at 2pm and wide awake at 11pm, that is not a discipline problem. That is a cortisol curve "
        "running backwards, and it shows up on a lab.\n\n"
        "Thyroid, ferritin, B12, vitamin D, blood sugar, inflammation, mitochondrial function — all measurable, most "
        "correctable, and most of them never checked.\n\n"
        "Comment TIRED and I will send you the panel that explains the 2pm crash.\n\n"
        "Free 15-minute consult — link in bio. Telehealth across California, in-person in Yorba Linda.\n\n"
        "#fatigue #cortisol #thyroidhealth #cellularmedicine #yorbalinda"
    ),
))

# --- 5: Brain fog ---
C.append(dict(
    slug="C5", title="5 · Brain Fog", kicker="Gut-Brain Medicine",
    hook=dict(
        headline="Brain fog that will not lift?",
        script="Start one floor down.",
        photo="PHOTO PLACEHOLDER\n\nHands around a mug, soft\nkitchen light, shallow depth\nof field. Calm, not clinical.",
    ),
    cause=dict(
        headline="The brain does not work in isolation",
        sub="Before we adjust anything psychiatric, we look at the biological environment the brain is operating in.",
        items=[
            ("Dysbiosis", "An imbalanced microbiome changes the signals your brain receives."),
            ("Intestinal permeability", "A compromised gut barrier drives systemic and neuro-inflammation."),
            ("Malabsorption", "B12, iron, magnesium and amino acids are the raw material for neurotransmitters."),
            ("Blood sugar instability", "The brain runs on glucose. Unstable input, unstable output."),
            ("Medication effects", "Some prescriptions contribute to the fog they were meant to lift."),
            ("Sleep & cortisol", "Deep sleep is when the brain clears. Less of it shows up as fog."),
        ],
    ),
    protocol=dict(
        headline="How we investigate",
        cards=[
            ("GI-MAP testing", "Comprehensive stool analysis for pathogens, dysbiosis, inflammatory and digestive markers and gut barrier function."),
            ("A targeted gut protocol", "Built from your results, not a generic cleanse. Antimicrobials, binders and professional-grade supplements as indicated."),
            ("Psychiatric medication review", "Medication management that accounts for the gut-brain axis, not just the symptom list."),
            ("Cellular support", "Nutrients and, where appropriate, compounded peptides aimed at gut lining repair and inflammation."),
        ],
        disclaimer=DISC_COMPOUND,
    ),
    caption=(
        "Brain fog gets treated as a mood problem more often than it should be.\n\n"
        "Dysbiosis, a compromised gut barrier, malabsorbed B12 and iron, unstable blood sugar, lost deep sleep — all of it "
        "changes how the brain runs, and none of it shows up in a 15-minute med check.\n\n"
        "Gut-brain medicine means testing the environment before adjusting the chemistry.\n\n"
        "Comment FOG and I will send you what a GI-MAP actually tests for.\n\n"
        "Free 15-minute consult — link in bio. Telehealth across California, in-person in Yorba Linda.\n\n"
        "Images are models, not patients.\n\n"
        "#brainfog #gutbrain #guthealth #psychiatry #yorbalinda"
    ),
))

# ======================= BUILD =======================

boards = {}
order = []
notes = {}

X0, XP = 0, 1160          # 1080 board + 80 gap
Y0, YP = 0, 1500          # 1080 board + 420 gap (room for row titles)

for r, c in enumerate(C):
    y = Y0 + r * YP
    slug = c["slug"]
    names = [
        ("Main.dc.html" if r == 0 else f"{slug}-Hook.dc.html", "Hook",
         hook(c["kicker"], **c["hook"]), f"{c['title']} — Hook"),
        (f"{slug}-Cause.dc.html", "Cause",
         cause(c["kicker"], **c["cause"]), f"{c['title']} — What's behind it"),
        (f"{slug}-Protocol.dc.html", "Protocol",
         protocol(c["kicker"], **c["protocol"]), f"{c['title']} — What may help"),
        (f"{slug}-CTA.dc.html", "CTA",
         cta(c["kicker"]), f"{c['title']} — Book a consult"),
    ]
    for i, (fname, _kind, bodyhtml, btitle) in enumerate(names):
        with open(os.path.join(PROJ, fname), "w", encoding="utf-8") as f:
            f.write(page(btitle, bodyhtml))
        boards[fname] = {
            "x": X0 + i * XP, "y": y, "w": 1080, "h": 1080,
            "title": f"{i+1}. {_kind}",
        }
        order.append(fname)

    notes[f"t{r+1}"] = {
        "x": X0, "y": y - 320,
        "text": f"{c['title']}",
        "kind": "title1", "maxW": 4560,
    }
    notes[f"cap{r+1}"] = {
        "x": X0 + 4 * XP + 40, "y": y,
        "text": "CAPTION\n\n" + c["caption"],
        "w": 860, "maxH": 1080, "color": "gray",
    }

notes["howto"] = {
    "x": X0, "y": Y0 - 760,
    "text": ("Five 4-slide Instagram carousels for Precision Vitality.\n\n"
             "Each row = one carousel, read left to right: 1) symptom hook  2) what is actually driving it  "
             "3) what we test and what may help  4) book a free 15-minute consult.\n\n"
             "Every slide is 1080 x 1080. Photo areas are marked placeholders — drop in the stock image "
             "described and delete the dashed box. Caption and hashtag copy for each carousel sits to the "
             "right of its row."),
    "w": 1600, "maxH": 460, "color": "gray",
}

index = {
    "v": 3,
    "createdOnFiles": {"v": 1, "at": "2026-09-18T06:30:00Z"},
    "title": "Precision Vitality — IG Carousels",
    "launch": {"view": "canvas"},
    "pages": [],
    "boards": boards,
    "order": order,
    "notes": notes,
    "designSystems": [],
}

with open(os.path.join(PROJ, "canvas.json"), "w", encoding="utf-8") as f:
    json.dump(index, f, indent=2, ensure_ascii=False)

print("wrote", len(order), "artboards")
for n in order:
    print(" ", n, os.path.getsize(os.path.join(PROJ, n)))
