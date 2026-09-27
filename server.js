const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const os = require("os");

const PORT = process.env.PORT || 5000;
const PARENT_PASSWORD = process.env.PARENT_PASSWORD || null;
const NGROK_DOMAIN = process.env.NGROK_DOMAIN || "chunk-refinance-breeching.ngrok-free.dev";
const MIME = { ".html":"text/html",".js":"application/javascript",".css":"text/css",".ico":"image/x-icon",".json":"application/json" };

// ── Session auth ──────────────────────────────────────────────
const validSessions = new Set();
const validChildTokens = new Map(); // token -> { expires, used }
function genToken(){ return Math.random().toString(36).slice(2)+Date.now().toString(36)+Math.random().toString(36).slice(2); }

// ── Logs & snapshots ──────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, "logs");
const SNAPS_DIR = path.join(__dirname, "snapshots");
[LOGS_DIR, SNAPS_DIR].forEach(d => { if(!fs.existsSync(d)) fs.mkdirSync(d, {recursive:true}); });

const sessionLog = [];
function logEvent(type, data){
  const entry = { ts: new Date().toISOString(), type, ...data };
  sessionLog.push(entry);
  // Keep last 1000 events in memory; append to daily log file
  const day = new Date().toISOString().slice(0,10);
  const logFile = path.join(LOGS_DIR, `${day}.jsonl`);
  fs.appendFile(logFile, JSON.stringify(entry)+"\n", ()=>{});
}

function saveSnapshot(childId, label, feedType, dataUrl){
  try{
    if(!dataUrl) return;
    const ts = new Date().toISOString().replace(/[:.]/g,"-");
    const fname = `${ts}_${childId}_${feedType}.jpg`;
    const fpath = path.join(SNAPS_DIR, fname);
    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/,"");
    fs.writeFile(fpath, Buffer.from(b64,"base64"), ()=>{
      broadcast({ type: "new-snapshot", file: fname, childId, label, feedType, ts: new Date().toISOString() });
    });
    logEvent("snapshot", { childId, label, feedType, file: fname });
  } catch(e){}
}

// ── HTTP handler ──────────────────────────────────────────────
function requestHandler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
  if(req.method === "OPTIONS"){
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Status endpoint
  if(pathname==="/status"){
    const childList=[];
    for(const [cid,cws] of children){
      childList.push({
        id:cid, label:cws._label,
        connectedAt:cws._connectedAt,
        uptimeSeconds:Math.floor((Date.now()-cws._connectedAt)/1000),
        screenLive:cws._screenLive||false,
        cameraLive:cws._cameraLive||false,
        lastLocation:cws._lastLocation||null,
        lastSeen:cws._lastSeen||null
      });
    }
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({
      serverUptime:Math.floor(process.uptime()),
      parentCount:parents.size,
      childCount:children.size,
      children:childList
    },null,2));
    return;
  }

  // Session log endpoint
  if(pathname==="/logs"){
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify(sessionLog.slice(-200), null, 2));
    return;
  }

  // List snapshots
  if(pathname==="/snapshots"){
    try{
      const files = fs.readdirSync(SNAPS_DIR).sort().reverse().slice(0,100);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(files));
    }catch(e){ res.writeHead(500); res.end("[]"); }
    return;
  }

  // Serve snapshot image
  if(pathname.startsWith("/snapshots/")){
    const fname = path.basename(pathname);
    const fpath = path.join(SNAPS_DIR, fname);
    if(fs.existsSync(fpath)){
      res.writeHead(200,{"Content-Type":"image/jpeg"});
      fs.createReadStream(fpath).pipe(res);
    } else { res.writeHead(404); res.end("Not found"); }
    return;
  }

  // Generate child token (parent requests this)
  if(pathname==="/gen-child-token"&&req.method==="POST"){
    const token = genToken();
    const expires = Date.now() + 24*60*60*1000; // 24h
    validChildTokens.set(token, { expires });
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({ token, expires, childUrl: `http://${req.headers.host}/child?token=${token}` }));
    return;
  }

  // Login
  if(pathname==="/login"&&req.method==="POST"){
    if(!PARENT_PASSWORD){ const tok=genToken(); validSessions.add(tok); res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":`pmsession=${tok};Path=/;HttpOnly`}); res.end(JSON.stringify({ok:true})); return; }
    let body=""; req.on("data",d=>body+=d); req.on("end",()=>{
      try{ const{password}=JSON.parse(body);
        if(password===PARENT_PASSWORD){ const tok=genToken(); validSessions.add(tok); res.writeHead(200,{"Content-Type":"application/json","Set-Cookie":`pmsession=${tok};Path=/;HttpOnly`}); res.end(JSON.stringify({ok:true})); }
        else{ res.writeHead(401); res.end(JSON.stringify({ok:false,error:"Wrong password"})); }
      }catch{ res.writeHead(400); res.end("Bad request"); }
    }); return;
  }

  let filePath;
  if(pathname==="/"||pathname==="/parent") filePath=path.join(__dirname,"parent.html");
  else if(pathname==="/child") filePath=path.join(__dirname,"child.html");
  else filePath=path.join(__dirname,pathname);

  if(filePath&&fs.existsSync(filePath)&&fs.statSync(filePath).isFile()){
    const ext=path.extname(filePath);
    res.writeHead(200,{"Content-Type":MIME[ext]||"text/plain"});
    fs.createReadStream(filePath).pipe(res);
  } else { res.writeHead(404); res.end("Not found"); }
}

const server = http.createServer(requestHandler);
const wss = new WebSocketServer({server, maxPayload:50*1024*1024, perMessageDeflate:false});

let nextId=1;
const parents=new Set();
const children=new Map();
const lastFrameCache=new Map();

// Snapshot interval per child
const snapshotIntervals = new Map();

function send(ws,obj){ if(ws&&ws.readyState===1){ try{ ws.send(JSON.stringify(obj)); }catch(e){} } }
function broadcast(obj){ for(const p of parents) send(p,obj); }

wss.on("connection",(ws,req)=>{
  const id=String(nextId++);
  ws._id=id; ws._role=null; ws._lastSeen=Date.now();

  if(req.socket){
    try{
      req.socket.setKeepAlive(true, 5000);
      req.socket.setNoDelay(true);
    }catch(e){}
  }

  // Active server ping every 10s
  const ping=setInterval(()=>{
    if(ws.readyState===1){
      try{ ws.ping(); }catch(e){}
    } else clearInterval(ping);
  },10000);

  ws.on("pong",()=>{ ws._lastSeen=Date.now(); });

  ws.on("message",(raw)=>{
    let msg; try{ msg=JSON.parse(raw); }catch{ return; }
    if(msg.type==="ping"){
      ws._lastSeen=Date.now();
      send(ws,{type:"pong",ts:Date.now()});
      return;
    }

    // ── Parent registration (with optional password) ──────────
    if(msg.type==="register-parent"){
      if(PARENT_PASSWORD && msg.password !== PARENT_PASSWORD){
        send(ws,{type:"auth-failed",reason:"Wrong password"});
        ws.close(); return;
      }
      ws._role="parent"; parents.add(ws);
      console.log(`[P] Parent registered (total:${parents.size})`);
      send(ws,{type:"registered-parent",serverTime:Date.now(),childCount:children.size});
      // Send current children immediately
      for(const[cid,cws] of children){
        send(ws,{type:"child-joined",childId:cid,label:cws._label,screenLive:cws._screenLive,cameraLive:cws._cameraLive,lastLocation:cws._lastLocation});
        const cache=lastFrameCache.get(cid)||{};
        if(cache.screen) send(ws,{type:"frame-screen",from:cid,data:cache.screen});
        if(cache.camera) send(ws,{type:"frame-camera",from:cid,data:cache.camera});
      }
      // Send recent session log
      send(ws,{type:"session-log",events:sessionLog.slice(-50)});
    }

    // ── Child registration ─────────────────────────────────────
    else if(msg.type==="register-child"){
      ws._role="child";
      ws._label=msg.label||"Device "+id;
      ws._connectedAt=Date.now();
      ws._screenLive=false; ws._cameraLive=false;
      ws._lastLocation=null;
      children.set(id,ws); lastFrameCache.set(id,{});
      console.log(`[C] Child: ${ws._label}`);
      send(ws,{type:"registered",id});
      broadcast({type:"child-joined",childId:id,label:ws._label,screenLive:false,cameraLive:false});
      logEvent("child-connected",{childId:id,label:ws._label});

      // Auto-snapshot every 60 seconds (active capture)
      const snapInt = setInterval(()=>{
        const cache=lastFrameCache.get(id)||{};
        if(cache.screen) saveSnapshot(id,ws._label,"screen",cache.screen);
        if(cache.camera) saveSnapshot(id,ws._label,"camera",cache.camera);
      }, 60*1000);
      snapshotIntervals.set(id, snapInt);
    }

    // ── Screen frame ───────────────────────────────────────────
    else if(msg.type==="frame-screen"||msg.type==="frame"){
      if(ws._role!=="child") return;
      ws._screenLive=true; ws._lastSeen=Date.now();
      const cache=lastFrameCache.get(ws._id)||{};
      cache.screen=msg.data; lastFrameCache.set(ws._id,cache);
      for(const p of parents) send(p,{type:"frame-screen",from:ws._id,data:msg.data});
    }

    // ── Camera frame ───────────────────────────────────────────
    else if(msg.type==="frame-camera"){
      if(ws._role!=="child") return;
      ws._cameraLive=true; ws._lastSeen=Date.now();
      const cache=lastFrameCache.get(ws._id)||{};
      cache.camera=msg.data; lastFrameCache.set(ws._id,cache);
      for(const p of parents) send(p,{type:"frame-camera",from:ws._id,data:msg.data});
    }

    // ── Location update ────────────────────────────────────────
    else if(msg.type==="location"){
      if(ws._role!=="child") return;
      ws._lastLocation=msg.coords;
      ws._lastSeen=Date.now();
      broadcast({type:"location",from:ws._id,label:ws._label,coords:msg.coords,ts:Date.now()});
      logEvent("location",{childId:ws._id,label:ws._label,coords:msg.coords});
    }

    // ── Motion alert (Super sensitive capture) ─────────────────
    else if(msg.type==="motion-alert"){
      if(ws._role!=="child") return;
      ws._lastSeen=Date.now();
      broadcast({type:"motion-alert",from:ws._id,label:ws._label,feed:msg.feed||"camera",ts:Date.now()});
      logEvent("motion",{childId:ws._id,label:ws._label,feed:msg.feed||"camera"});
      // Save high-resolution snapshot on motion immediately
      if(msg.snapshot){
        saveSnapshot(ws._id,ws._label,msg.feed||"motion",msg.snapshot);
      } else {
        const cache=lastFrameCache.get(ws._id)||{};
        if(cache.camera) saveSnapshot(ws._id,ws._label,"camera-motion",cache.camera);
        if(cache.screen) saveSnapshot(ws._id,ws._label,"screen-motion",cache.screen);
      }
    }

    // ── Save snapshot on direct request ────────────────────────
    else if(msg.type==="save-snapshot"){
      if(msg.data){
        saveSnapshot(msg.childId||ws._id, msg.label||ws._label||"device", msg.feedType||"manual", msg.data);
      }
    }

    // ── Stop feeds ─────────────────────────────────────────────
    else if(msg.type==="stop-screen"){
      ws._screenLive=false;
      const cache=lastFrameCache.get(ws._id)||{}; cache.screen=null; lastFrameCache.set(ws._id,cache);
      broadcast({type:"stop-screen",from:ws._id});
    }
    else if(msg.type==="stop-camera"){
      ws._cameraLive=false;
      const cache=lastFrameCache.get(ws._id)||{}; cache.camera=null; lastFrameCache.set(ws._id,cache);
      broadcast({type:"stop-camera",from:ws._id});
    }
    else if(msg.type==="stop-frame"){
      ws._screenLive=false; ws._cameraLive=false;
      lastFrameCache.set(ws._id,{});
      broadcast({type:"stop-screen",from:ws._id});
      broadcast({type:"stop-camera",from:ws._id});
    }

    // ── Remote commands (parent → child) ──────────────────────
    else if(msg.type==="cmd"&&ws._role==="parent"){
      const target=children.get(msg.childId);
      if(target) send(target,{type:"cmd",cmd:msg.cmd,payload:msg.payload||{}});
    }

    // ── Disconnect child ───────────────────────────────────────
    else if(msg.type==="disconnect-child"&&ws._role==="parent"){
      const t=children.get(msg.childId);
      if(t) send(t,{type:"force-stop"});
    }
  });

  ws.on("close",(code)=>{
    clearInterval(ping);
    console.log(`[-] id=${id} role=${ws._role} code=${code}`);
    if(ws._role==="parent"){ parents.delete(ws); }
    else if(ws._role==="child"){
      clearInterval(snapshotIntervals.get(id));
      snapshotIntervals.delete(id);
      children.delete(id); lastFrameCache.delete(id);
      broadcast({type:"child-left",childId:id});
      logEvent("child-disconnected",{childId:id,label:ws._label});
    }
  });
  ws.on("error",(e)=>{ clearInterval(ping); console.log(`[!] id=${id}:`,e.message); });
});

// Heartbeat checker: mark children offline only if no activity in 60s
setInterval(()=>{
  const now=Date.now();
  for(const[cid,cws] of children){
    const age=(now-(cws._lastSeen||now))/1000;
    if(age>60) broadcast({type:"child-offline",childId:cid,ageSeconds:Math.floor(age)});
  }
},5000);

server.listen(PORT,"0.0.0.0",()=>{
  const nets=os.networkInterfaces(); let lanIp="localhost";
  for(const ifaces of Object.values(nets)) for(const i of ifaces) if(i.family==="IPv4"&&!i.internal) lanIp=i.address;
  console.log("\n✅ Screen Monitor — Ultra-Responsive Agent Edition (Port " + PORT + ")");
  console.log(`   Local Parent:    http://localhost:${PORT}/parent`);
  console.log(`   Local Child:     http://localhost:${PORT}/child`);
  console.log(`   🌐 Ngrok Parent: https://${NGROK_DOMAIN}/parent`);
  console.log(`   🌐 Ngrok Child:  https://${NGROK_DOMAIN}/child`);
  console.log(`   LAN Network:     http://${lanIp}:${PORT}`);
  console.log(`   Status:          http://localhost:${PORT}/status`);
  console.log(`   Snapshots:       http://localhost:${PORT}/snapshots\n`);
  if(PARENT_PASSWORD) console.log("   🔐 Password protection: ON\n");
});
