import json,os,sys,urllib.request,urllib.error
# tiny chess engine, <4KB (packed). Pure deterministic alpha-beta,
# killer + history ordering, quiescence, PST + pawn/king terms.
# Protocol: /game then /move until done.
E=os.environ.get("MAKEFUN_ENV_URL")or sys.exit("no env")
W,B=1,-1;P,N,BB,R,Q,K=1,2,3,4,5,6
V={1:100,2:320,3:330,4:500,5:900,6:20000}
F='abcdefgh';KN=[17,15,10,6,-6,-10,-15,-17];BI=[9,7,-7,-9];RO=[8,1,-1,-8];KI=[9,8,7,1,-1,-7,-8,-9]
BUD=8000
PST={1:[0,0,0,0,0,0,0,0,50,50,50,50,50,50,50,50,10,10,20,30,30,20,10,10,5,5,10,25,25,10,5,5,0,0,0,20,20,0,0,0,5,-5,-10,0,0,-10,-5,5,5,10,10,-20,-20,10,10,5,0,0,0,0,0,0,0,0],
2:[-50,-40,-30,-30,-30,-30,-40,-50,-40,-20,0,0,0,0,-20,-40,-30,0,10,15,15,10,0,-30,-30,5,15,20,20,15,5,-30,-30,0,15,20,20,15,0,-30,-30,5,10,15,15,10,5,-30,-40,-20,0,5,5,0,-20,-40,-50,-40,-30,-30,-30,-30,-40,-50],
3:[-20,-10,-10,-10,-10,-10,-10,-20,-10,0,0,0,0,0,0,-10,-10,0,5,10,10,5,0,-10,-10,5,5,10,10,5,5,-10,-10,0,10,10,10,10,0,-10,-10,10,10,10,10,10,10,-10,-10,5,0,0,0,0,5,-10,-20,-10,-10,-10,-10,-10,-10,-20],
4:[0,0,0,0,0,0,0,0,5,10,10,10,10,10,10,5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,0,0,0,5,5,0,0,0],
5:[-20,-10,-10,-5,-5,-10,-10,-20,-10,0,0,0,0,0,0,-10,-10,0,5,5,5,5,0,-10,-5,0,5,5,5,5,0,-5,0,0,5,5,5,5,0,-5,-10,5,5,5,5,5,0,-10,-10,0,5,0,0,0,0,-10,-20,-10,-10,-5,-5,-10,-10,-20],
6:[-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-20,-30,-30,-40,-40,-30,-30,-20,-10,-20,-20,-20,-20,-20,-20,-10,20,20,0,0,0,0,20,20]}
def sn(s):return F[s%8]+str(8-s//8)
def uci(m):return sn(m[0])+sn(m[1])+(chr(m[2])if m[2]else'')
def mkb(fen):
 b=[0]*64
 for r,row in enumerate(fen.split()[0].split('/')):
  f=0
  for c in row:
   if c.isdigit():f+=int(c)
   else:
    pc={'p':P,'n':N,'b':BB,'r':R,'q':Q,'k':K}.get(c.lower(),0)
    b[r*8+f]=pc if c.isupper() else -pc;f+=1
 return b
def at(b,by,ks):
 for i in range(64):
  p=b[i]
  if p==0 or(p>0)!=(by>0):continue
  pp=abs(p)
  if pp==P:
   d=-8 if by==W else 8
   for df in(-1,1):
    t=i+d+df
    if 0<=t<64 and(i%8)+df in(0,7)and t==ks:return 1
  elif pp==N:
   for dd in KN:
    t=i+dd
    if 0<=t<64 and t==ks and abs((t%8)-(i%8))<=2:
     if abs((t%8)-(i%8))==2 and abs(t//8-i//8)==1:continue
     return 1
  elif pp in(BB,R,Q):
   dirs=BI if pp==BB else(RO if pp==R else BI+RO)
   for dd in dirs:
    t=i+dd
    while 0<=t<64:
     if dd in(1,-1):
      if(t%8-i%8)*dd<=0:break
     elif dd in(9,7,-7,-9):
      if abs((t%8)-(i%8))!=1:break
     if b[t]!=0:
      if t==ks:return 1
      break
     t+=dd
  else:
   for dd in KI:
    t=i+dd
    if 0<=t<64 and abs((t%8)-(i%8))<=1 and t==ks:return 1
 return 0
def genm(b,side,ca,ep):
 mv=[];kq=next(i for i in range(64)if b[i]==side*K)
 def push(f,t,pr):
  if abs(b[t])==K:return 0
  b2=b[:];b2[t]=b2[f];b2[f]=0
  if abs(b[f])==P and t==ep and b[t]==0 and(f%8)!=(t%8):b2[t-8 if side==W else t+8]=0
  k2=t if b[f]==side*K else kq
  return not at(b2,-side,k2)
 for f in range(64):
  p=b[f]
  if p==0 or(p>0)!=(side>0):continue
  pp=abs(p)
  if pp==P:
   d=-8 if side==W else 8;st=6 if side==W else 1
   t=f+d
   if 0<=t<64 and b[t]==0:
    if t//8 in(0,7):
     for pr in(Q,N,BB,R):
      if push(f,t,pr):mv.append((f,t,pr))
    else:
     if push(f,t,0):mv.append((f,t,0))
    t2=f+2*d
    if f//8==st and b[t2]==0:
     if push(f,t2,0):mv.append((f,t2,0))
   for df in(-1,1):
    t=f+d+df
    if 0<=t<64 and(f%8)+df in(0,7):
     if b[t]!=0 and(b[t]>0)!=(side>0):
      if t//8 in(0,7):
       for pr in(Q,N,BB,R):
        if push(f,t,pr):mv.append((f,t,pr))
      else:
       if push(f,t,0):mv.append((f,t,0))
     elif t==ep and b[t]==0:
      if push(f,t,0):mv.append((f,t,0))
  elif pp==N:
   for dd in KN:
    t=f+dd
    if 0<=t<64 and abs((t%8)-(f%8))<=2:
     if b[t]==0 or(b[t]>0)!=(side>0):
      if push(f,t,0):mv.append((f,t,0))
  elif pp in(BB,R,Q):
   dirs=BI if pp==BB else(RO if pp==R else BI+RO)
   for dd in dirs:
    t=f+dd
    while 0<=t<64:
     if dd in(1,-1):
      if(t%8-f%8)*dd<=0:break
     elif dd in(9,7,-7,-9):
      if abs((t%8)-(f%8))!=1:break
     if b[t]==0:
      if push(f,t,0):mv.append((f,t,0))
     else:
      if(b[t]>0)!=(side>0):
       if push(f,t,0):mv.append((f,t,0))
      break
     t+=dd
  else:
   for dd in KI:
    t=f+dd
    if 0<=t<64 and abs((t%8)-(f%8))<=1:
     if b[t]==0 or(b[t]>0)!=(side>0):
      if push(f,t,0):mv.append((f,t,0))
   if side==W and f==4:
    if'K'in ca and b[5]==0 and b[6]==0 and b[7]==R and not at(b,B,4)and not at(b,B,5)and not at(b,B,6):
     if push(4,6,0):mv.append((4,6,0))
    if'Q'in ca and b[3]==0 and b[2]==0 and b[1]==0 and b[0]==R and not at(b,B,4)and not at(b,B,3)and not at(b,B,2):
     if push(4,2,0):mv.append((4,2,0))
   elif side==B and f==60:
    if'k'in ca and b[61]==0 and b[62]==0 and b[63]==R and not at(b,W,60)and not at(b,W,61)and not at(b,W,62):
     if push(60,62,0):mv.append((60,62,0))
    if'q'in ca and b[59]==0 and b[58]==0 and b[57]==0 and b[56]==R and not at(b,W,60)and not at(b,W,59)and not at(b,W,58):
     if push(60,58,0):mv.append((60,58,0))
 return mv
MR=[56,57,58,59,60,61,62,63,48,49,50,51,52,53,54,55,40,41,42,43,44,45,46,47,32,33,34,35,36,37,38,39,24,25,26,27,28,29,30,31,16,17,18,19,20,21,22,23,8,9,10,11,12,13,14,15,0,1,2,3,4,5,6,7]
def evl(b,side):
 s=0;bp=[0,0]
 for i in range(64):
  p=b[i]
  if p==0:continue
  pc=abs(p);v=V[pc]+(PST[pc][i] if p>0 else PST[pc][MR[i]])
  s+=v if p>0 else -v
  if pc==BB:
   if p>0:bp[0]+=1
   else:bp[1]+=1
 if bp[0]>=2:s+=45
 if bp[1]>=2:s-=45
 for f in range(8):
  wc=bc=0;wp=8;bpp=8
  for r in range(8):
   pp=b[r*8+f]
   if pp==P:wc+=1;wp=min(wp,r)
   elif pp==-P:bc+=1;bpp=min(bpp,r)
  if wc>1:s-=15*(wc-1)
  if bc>1:s+=15*(bc-1)
  if wc and bpp==8:s+=10*(8-wp)
  if bc and wp==8:s-=10*(bpp+1)
 try: kiw=b.index(K)
 except: kiw=0
 try: kib=b.index(-K)
 except: kib=0
 for df in(-1,0,1):
  t=kiw-8+df
  if 0<=t<64 and b[t]==P:s+=12
  t=kiw-16+df
  if 0<=t<64 and b[t]==P:s+=6
  t=kib+8+df
  if 0<=t<64 and b[t]==-P:s-=12
  t=kib+16+df
  if 0<=t<64 and b[t]==-P:s-=6
 return s if side==W else -s

def qsc(b,side,ca,ep,a,be,d,nb):
 nb[0]+=1;st=evl(b,side)
 if d==0 or st>=be:return st
 if st>a:a=st
 caps=[m for m in genm(b,side,ca,ep) if b[m[1]]!=0 or(abs(b[m[0]])==P and m[1]==ep)]
 caps.sort(key=lambda m:-abs(b[m[1]] or 100))
 for m in caps:
  if nb[0]>BUD:return st
  sc=-qsc(ply(b,m,side,ep),-side,ca,ep,-be,-a,d-1,nb)
  if sc>=be:return sc
  if sc>a:a=sc
 return a
def ply(b,m,side,ep):
 f,t,pr=m;b2=b[:];b2[f]=0;b2[t]=pr or b[f]
 if abs(b[f])==P and t==ep and b[t]==0 and(f%8)!=(t%8):b2[t-8 if side==W else t+8]=0
 return b2
KL=[None]*8;H={}
def srch(b,side,ca,ep,d,a,be,nb):
 nb[0]+=1
 if d==0:return qsc(b,side,ca,ep,a,be,1,nb)
 ms=genm(b,side,ca,ep)
 if not ms:
  kq=next(i for i in range(64)if b[i]==side*K)
  return -99999-(10-d)*10 if at(b,-side,kq)else 0
 kl=KL[d]
 ms.sort(key=lambda m:(0 if m==kl else 1 if b[m[1]] or(abs(b[m[0]])==P and m[1]==ep) else 2,H.get(m,0)),reverse=True)
 best=-1e9;bm=None
 for m in ms:
  if nb[0]>BUD:return best
  sc=-srch(ply(b,m,side,ep),-side,ca,ep,d-1,-be,-a,nb)
  if sc>best:best=sc;bm=m
  if best>a:a=best
  if a>=be:
   if bm is not None and not b[bm[1]]:KL[d]=bm;H[bm]=H.get(bm,0)+1
   break
 return best
def choose(fen,lg,ca,ep,side):
 b=mkb(fen);par=[]
 for u in lg:
  f=(8-int(u[1]))*8+F.index(u[0]);t=(8-int(u[3]))*8+F.index(u[2]);pr=0
  if len(u)==5:pr={'q':Q,'n':N,'b':BB,'r':R}[u[4]]
  par.append((f,t,pr))
 nb=[0];best=par[0]
 for d in range(1,7):
  lb=None;lbs=-1e9;done=1
  for m in par:
   if nb[0]>BUD:done=0;break
   sc=-srch(ply(b,m,side,ep),-side,ca,ep,d,-1e9,1e9,nb)
   if sc>lbs:lbs=sc;lb=m
  if done and lb is not None:best=lb
  if not done:break
 return uci(best)
def RQ(path,body):
 req=urllib.request.Request(E+path,data=json.dumps(body).encode(),headers={"content-type":"application/json"})
 try:
  with urllib.request.urlopen(req)as r:return json.load(r)
 except urllib.error.HTTPError as e:sys.exit(f"{path}: HTTP {e.code} {e.read().decode(errors='replace')}")
if __name__=="__main__":
 while 1:
  g=RQ('/game',{})
  if g['status']=='done':break
  while g['status']=='your_move':
   fen=g['fen'];parts=fen.split();ca=parts[2]if len(parts)>2 else'-';ep=-1
   if len(parts)>3 and parts[3]!='-':ep=(8-int(parts[3][1]))*8+F.index(parts[3][0])
   side=W if parts[1]=='w' else B
   g=RQ('/move',{'game':g['game'],'move':choose(fen,g['legal_moves'],ca,ep,side)})
  print(f"game {g['game']}: {g['outcome']} by {g['reason']}",file=sys.stderr)
 print(f"done: {g.get('wins')} won, {g.get('draws')} drawn, {g.get('losses')} lost",file=sys.stderr)
