import io,requests
from PIL import Image,ImageFilter,ImageEnhance,ImageDraw,ImageFont
from pathlib import Path

SRC='https://artworks.thetvdb.com/banners/v4/series/462729/icons/6a9dc58561428.png'
OUT=Path('/tmp/elian-ventre-poster.jpg')
r=requests.get(SRC,timeout=30)
r.raise_for_status()
src=Image.open(io.BytesIO(r.content)).convert('RGB')

W,H=1360,2000
# Background from the same official profile image, cropped and blurred.
bg=src.copy()
scale=max(W/bg.width,H/bg.height)
bg=bg.resize((round(bg.width*scale),round(bg.height*scale)),Image.Resampling.LANCZOS)
left=(bg.width-W)//2; top=(bg.height-H)//2
bg=bg.crop((left,top,left+W,top+H)).filter(ImageFilter.GaussianBlur(42))
bg=ImageEnhance.Brightness(bg).enhance(0.38)

# Keep the official profile image un-stretched in a centered square.
avatar=src.resize((1040,1040),Image.Resampling.LANCZOS)
canvas=bg
canvas.paste(avatar,((W-1040)//2,210))

# Dark lower panel and series name.
overlay=Image.new('RGBA',(W,H),(0,0,0,0))
od=ImageDraw.Draw(overlay)
od.rectangle((0,1320,W,H),fill=(0,0,0,170))
canvas=Image.alpha_composite(canvas.convert('RGBA'),overlay)

draw=ImageDraw.Draw(canvas)
font_path='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
font=ImageFont.truetype(font_path,112)
text='ELIAN VENTRE'
bbox=draw.textbbox((0,0),text,font=font)
tw=bbox[2]-bbox[0]
draw.text(((W-tw)//2,1540),text,font=font,fill='white')

canvas.convert('RGB').save(OUT,'JPEG',quality=94,subsampling=0)
im=Image.open(OUT)
assert im.size==(1360,2000)
assert OUT.stat().st_size < 10_000_000
print(str(OUT))
