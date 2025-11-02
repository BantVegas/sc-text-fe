import { useMemo, useRef, useState, useEffect } from "react";

// ===== ENV =====
const JAVA_BASE = import.meta.env.VITE_JAVA_BASE_URL || "http://localhost:8080";
const PY_BASE   = import.meta.env.VITE_PY_BASE_URL   || "http://localhost:8011";

// ===== helpers =====
const fileToDataURL = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/** Spracovanie obrázka: zmenšenie + JPEG kompresia + VOLITEĽNÁ rotácia (deg = -180..180). */
async function processImage(
  file: File,
  opts: { rotateDeg?: number; maxSide?: number; maxBytes?: number } = {}
) {
  const rotateDeg = opts.rotateDeg ?? 0;
  const maxSide   = opts.maxSide  ?? 4000;
  const maxBytes  = opts.maxBytes ?? 20 * 1024 * 1024;

  const src = await fileToDataURL(file);
  const img = await loadImage(src);

  // scale
  const scale = Math.max(img.width, img.height) > maxSide ? maxSide / Math.max(img.width, img.height) : 1;
  const w0 = Math.max(1, Math.round(img.width  * scale));
  const h0 = Math.max(1, Math.round(img.height * scale));

  // canvas rozmery po rotácii
  const normDeg = ((rotateDeg % 360) + 360) % 360; // 0..359
  const rot90 = normDeg === 90 || normDeg === 270;

  const canvas = document.createElement("canvas");
  canvas.width  = rot90 ? h0 : w0;
  canvas.height = rot90 ? w0 : h0;

  const ctx = canvas.getContext("2d");
  if (!ctx) return file;

  // kreslenie s rotáciou
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((normDeg * Math.PI) / 180);
  ctx.drawImage(img, -w0 / 2, -h0 / 2, w0, h0);

  // export JPEG s iteráciou kvality
  let q = 0.92;
  let blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", q));
  if (!blob) return file;
  while (blob.size > maxBytes && q > 0.6) {
    q -= 0.08;
    blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", q));
    if (!blob) break;
  }
  if (!blob) return file;

  const out = new File([blob], file.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg", { type: "image/jpeg" });
  return out;
}

function iou(a:{x:number;y:number;w:number;h:number}, b:{x:number;y:number;w:number;h:number}) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = a.w * a.h + b.w * b.h - inter;
  return ua > 0 ? inter / ua : 0;
}

function dedupeBoxes<T extends {x:number;y:number;w:number;h:number;type?:string;subType?:string|null}>(arr: T[], thr = 0.9) {
  const out: T[] = [];
  for (const b of arr) {
    const dup = out.find(o => iou(o, b) >= thr && (o.type || "") === (b.type || ""));
    if (!dup) out.push(b);
  }
  return out;
}

const toImgUrl = (maybeDataUrlOrB64: string): string => {
  if (!maybeDataUrlOrB64) return "";
  if (maybeDataUrlOrB64.startsWith("data:")) return maybeDataUrlOrB64;
  return `data:image/jpeg;base64,${maybeDataUrlOrB64}`;
};

async function fetchJSON(url: string, fd: FormData) {
  const r = await fetch(url, { method: "POST", body: fd });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) return await r.json();
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

// ===== types =====
type Box = { x:number; y:number; w:number; h:number; type?: "ocr" | "barcode" | "diff"; subType?: string|null; desc?: string; };
type OcrDiff = { line:number; master:string; scan:string };
type BcItem = { side?: "master" | "scan"; symbology:string; value:string; valid:boolean; reason?:string|null };

type LabelView = {
  url:string; w:number; h:number; boxes:Box[];
  ocrMaster?:string; ocrScan?:string; ocrDiffs?: OcrDiff[];
  barcode?: BcItem[]; barcodeMatch?: boolean;
};

// riadkový diff, ak BE nedodá
function makeLineDiffs(master = "", scan = ""): OcrDiff[] {
  const A = master.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const B = scan.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const L = Math.max(A.length, B.length);
  const diffs: OcrDiff[] = [];
  for (let i=0;i<L;i++){
    const a = A[i] ?? "";
    const b = B[i] ?? "";
    if (a !== b) diffs.push({ line: i+1, master: a, scan: b });
  }
  return diffs;
}

// deduplikácia kódov (strana+symbology+value)
function dedupeBc(items: BcItem[]): BcItem[] {
  const map = new Map<string, BcItem>();
  for (const b of items || []) {
    const key = `${b.side||""}|${(b.symbology||"").toUpperCase()}|${String(b.value||"").trim()}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        ...b,
        symbology: (b.symbology||"").toUpperCase(),
        value: String(b.value||"").trim()
      });
    } else {
      cur.valid = cur.valid && b.valid;
      if (!cur.reason && b.reason) cur.reason = b.reason;
    }
  }
  return [...map.values()];
}

export default function Compare() {
  // files & previews
  const [masterRaw, setMasterRaw] = useState<File|null>(null);
  const [masterFile, setMasterFile] = useState<File|null>(null);
  const [masterUrl, setMasterUrl] = useState<string>("");
  const [masterRot, setMasterRot] = useState<number>(0);

  const [etiketaRaw, setEtiketaRaw] = useState<File|null>(null);
  const [etiketaFile, setEtiketaFile] = useState<File|null>(null);
  const [etiketaUrl, setEtiketaUrl] = useState<string>("");
  const [etiketaRot, setEtiketaRot] = useState<number>(0);

  const [isComparing, setIsComparing] = useState(false);
  const [view, setView] = useState<LabelView|null>(null);

  // report meta
  const [operatorName, setOperatorName]   = useState(localStorage.getItem("etis_operator") || "");
  const [orderNumber, setOrderNumber]     = useState(localStorage.getItem("etis_order") || "");
  const [productNumber, setProductNumber] = useState(localStorage.getItem("etis_product") || "");
  const [generatedAt, setGeneratedAt]     = useState<Date | null>(null);

  useEffect(() => { localStorage.setItem("etis_operator", operatorName) }, [operatorName]);
  useEffect(() => { localStorage.setItem("etis_order", orderNumber) }, [orderNumber]);
  useEffect(() => { localStorage.setItem("etis_product", productNumber) }, [productNumber]);

  // upload handlers (s rotáciou)
  const onMaster = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f0 = e.target.files?.[0];
    if (!f0) { setMasterRaw(null); setMasterFile(null); setMasterUrl(""); return; }
    setMasterRaw(f0);
    const f = await processImage(f0, { rotateDeg: masterRot });
    setMasterFile(f); setMasterUrl(await fileToDataURL(f));
  };
  const onEtiketa = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f0 = e.target.files?.[0];
    if (!f0) { setEtiketaRaw(null); setEtiketaFile(null); setEtiketaUrl(""); return; }
    setEtiketaRaw(f0);
    const f = await processImage(f0, { rotateDeg: etiketaRot });
    setEtiketaFile(f); setEtiketaUrl(await fileToDataURL(f));
  };

  // rotácia tlačidlami
  const rotateMaster = async (delta: number) => {
    if (!masterRaw) return;
    const next = ((masterRot + delta) % 360 + 360) % 360;
    setMasterRot(next);
    const f = await processImage(masterRaw, { rotateDeg: next });
    setMasterFile(f); setMasterUrl(await fileToDataURL(f));
  };
  const rotateEtiketa = async (delta: number) => {
    if (!etiketaRaw) return;
    const next = ((etiketaRot + delta) % 360 + 360) % 360;
    setEtiketaRot(next);
    const f = await processImage(etiketaRaw, { rotateDeg: next });
    setEtiketaFile(f); setEtiketaUrl(await fileToDataURL(f));
  };
  const resetMasterRotation = async () => { if (masterRaw){ setMasterRot(0); const f=await processImage(masterRaw,{rotateDeg:0}); setMasterFile(f); setMasterUrl(await fileToDataURL(f)); } };
  const resetEtiketaRotation = async () => { if (etiketaRaw){ setEtiketaRot(0); const f=await processImage(etiketaRaw,{rotateDeg:0}); setEtiketaFile(f); setEtiketaUrl(await fileToDataURL(f)); } };

  // ==== main compare ====
  async function doCompare() {
    if (!masterFile || !etiketaFile) { alert("Najprv nahraj master aj etiketu."); return; }
    setIsComparing(true);
    try {
      const fd = new FormData();
      fd.append("master", masterFile);
      fd.append("etiketa", etiketaFile);
      fd.append("operator", operatorName);
      fd.append("productNumber", productNumber);
      fd.append("orderNumber", orderNumber);
      fd.append("spoolNumber", orderNumber); // kompatibilita s BE

      // 1) Java
      let resp: any = await fetchJSON(`${JAVA_BASE}/api/compare-one`, fd).catch(() => null);
      if (!resp) {
        // 2) Python
        resp = await fetchJSON(`${PY_BASE}/api/compare-one`, fd).catch(() => null);
      }
      if (!resp) {
        // 3) fallback starý /api/compare
        const img = await loadImage(masterUrl);
        const fd2 = new FormData();
        fd2.append("master", masterFile);
        fd2.append("scan",   etiketaFile);
        fd2.append("rows", "1"); fd2.append("cols", "1");
        fd2.append("label_w", String(img.width));
        fd2.append("label_h", String(img.height));
        fd2.append("gap_x", "0"); fd2.append("gap_y", "0");
        fd2.append("dpi", "800"); fd2.append("wind", "A1");
        resp = await fetchJSON(`${PY_BASE}/api/compare`, fd2);
      }

      // --- normalizácia na LabelView ---
      let label: LabelView | null = null;

      if (resp && (resp.ocr || resp.barcode || resp.barcodes || resp.graphics)) {
        const url = toImgUrl(resp.image || etiketaUrl);
        const w = Number(resp.w || resp.width) || 0;
        const h = Number(resp.h || resp.height) || 0;

        const boxes: Box[] = dedupeBoxes([
          ...(Array.isArray(resp.graphics?.boxes) ? resp.graphics.boxes : []).map((b:any)=>({
            x:+(b.x||b[0]||0), y:+(b.y||b[1]||0), w:+(b.w||b[2]||1), h:+(b.h||b[3]||1),
            type:"diff", subType:b.subType||null, desc:b.desc||"Rozdiel"
          }))
        ]);

        const ocrMaster = resp.ocr?.masterText || "";
        const ocrScan   = resp.ocr?.scanText   || "";
        const ocrDiffs: OcrDiff[] = Array.isArray(resp.ocr?.diffs) ? resp.ocr.diffs : makeLineDiffs(ocrMaster, ocrScan);

        // barcode
        let bcItems: BcItem[] = [];
        let bcMatch: boolean | undefined = undefined;

        if (resp.barcode && Array.isArray(resp.barcode.items)) {
          bcItems = resp.barcode.items.map((b:any)=>({
            symbology: b.symbology || b.type || "-",
            value: b.value || b.text || "-",
            valid: !!b.valid,
            reason: b.reason || null
          }));
          if (typeof resp.barcode.match === "boolean") bcMatch = resp.barcode.match;
        }
        if (resp.barcodes) {
          const mArr = Array.isArray(resp.barcodes.master) ? resp.barcodes.master : [];
          const sArr = Array.isArray(resp.barcodes.scan)   ? resp.barcodes.scan   : [];
          bcItems = [
            ...mArr.map((b:any)=>({ side:"master" as const, symbology:b.type||b.symbology||"-", value:b.data||b.value||"-", valid: !!(b.valid ?? true), reason:b.reason||null })),
            ...sArr.map((b:any)=>({ side:"scan"   as const, symbology:b.type||b.symbology||"-", value:b.data||b.value||"-", valid: !!(b.valid ?? true), reason:b.reason||null })),
          ];
          if (typeof resp.barcodes.match === "boolean") bcMatch = resp.barcodes.match;
          if (bcMatch === undefined && mArr.length && sArr.length) {
            const mSet = new Set(mArr.map((b:any)=>String(b.data||b.value||"")));
            bcMatch = sArr.some((b:any)=>mSet.has(String(b.data||b.value||"")));
          }
        }

        label = {
          url, w, h, boxes,
          ocrMaster, ocrScan, ocrDiffs,
          barcode: dedupeBc(bcItems),
          barcodeMatch: bcMatch
        };
      }

      if (!label) {
        console.warn("Neznámy formát odpovede:", resp);
        alert("Porovnanie nevrátilo použiteľný výsledok.");
        setView(null);
        return;
      }

      setView(label);
      setGeneratedAt(new Date());
    } catch (e:any) {
      alert("Chyba porovnania: " + (e?.message || String(e)));
      setView(null);
    } finally {
      setIsComparing(false);
    }
  }

  // ===== overlay canvas =====
  function Overlay({ src, w, h, boxes }: { src:string; w:number; h:number; boxes:Box[] }) {
    const [nat, setNat] = useState<{w:number;h:number}>({w:0,h:0});
    const [size, setSize] = useState<{w:number;h:number}>({w:0,h:0});
    const ref = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const img = new Image();
      img.onload = () => {
        setNat({ w: img.width, h: img.height });
        const recalc = () => {
          const cw = containerRef.current?.clientWidth || img.width;
          const ratio = (h || img.height) / (w || img.width);
          setSize({ w: Math.round(cw), h: Math.round(cw * ratio) });
        };
        recalc();
        window.addEventListener("resize", recalc);
        return () => window.removeEventListener("resize", recalc);
      };
      img.src = src;
    }, [src, w, h]);

    useEffect(() => {
      const c = ref.current; if (!c) return;
      const ctx = c.getContext("2d"); if (!ctx) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
      c.style.width = `${size.w}px`;
      c.style.height = `${size.h}px`;
      ctx.setTransform(dpr,0,0,dpr,0,0);

      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0,0,size.w,size.h);
        ctx.drawImage(img, 0, 0, size.w, size.h);
        const sx = size.w / (w || nat.w || 1);
        const sy = size.h / (h || nat.h || 1);
        boxes.forEach(b => {
          ctx.save();
          ctx.strokeStyle = b.type === "ocr" ? "#eab308" : (b.type === "barcode" ? "#06b6d4" : "#ef4444");
          if (b.type === "ocr") ctx.setLineDash([6,4]);
          ctx.lineWidth = 2;
          ctx.strokeRect(Math.round(b.x*sx), Math.round(b.y*sy), Math.round(b.w*sx), Math.round(b.h*sy));
          ctx.restore();
        });
      };
      img.src = src;
    }, [src, size, boxes, w, h, nat]);

    return (
      <div ref={containerRef} className="w-full">
        <canvas ref={ref} className="rounded-xl border border-slate-200 bg-white" />
      </div>
    );
  }

  // ===== uložiť / tlačiť =====
  function saveReport() {
    if (!view) return;
    const report = {
      createdAt: (generatedAt ?? new Date()).toISOString(),
      operator: operatorName,
      orderNumber,
      productNumber,
      summary: {
        ocr: view.ocrMaster && view.ocrScan && view.ocrMaster.trim() !== view.ocrScan.trim() ? "Chyba" : "OK",
        barcode: (view.barcodeMatch === false) || (view.barcode||[]).some(b=>b.valid===false) ? "Chyba" :
                 (view.barcode && view.barcode.length ? "OK" : "Bez kódu"),
        graphics: (view.boxes||[]).some(b=>b.type==="diff") ? "Chyba" : "OK",
      },
      ocr: { master: view.ocrMaster, scan: view.ocrScan, diffs: view.ocrDiffs || [] },
      barcode: { match: view.barcodeMatch, items: view.barcode || [] },
      graphics: { diffBoxes: view.boxes || [] },
      image: view.url
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `scancontroll-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function printPage() { window.print(); }

  // ===== summary badges =====
  const summary = useMemo(() => {
    if (!view) return { ocr:"–", bc:"–", gfx:"–", bcMismatch:false };
    const hasTextErr = !!(view.ocrMaster && view.ocrScan && view.ocrMaster.trim() && view.ocrScan.trim() && view.ocrMaster.trim() !== view.ocrScan.trim());
    const bcMismatch = (view.barcodeMatch === false);
    const bcHasErr = bcMismatch || (view.barcode || []).some(b => b.valid === false);
    const gfxHasErr = (view.boxes || []).some(b => b.type === "diff");
    return {
      ocr: hasTextErr ? "Chyba" : "OK",
      bc: bcHasErr ? "Chyba" : (view.barcode && view.barcode.length ? "OK" : "Bez kódu"),
      gfx: gfxHasErr ? "Chyba" : "OK",
      bcMismatch
    };
  }, [view]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 print:bg-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* HEADER s poliami */}
        <header className="mb-6 flex items-center justify-between print:hidden">
          <h1 className="text-2xl font-bold">ETIS ScanControll</h1>
          <div className="flex items-center gap-3">
            <input
              value={operatorName}
              onChange={(e)=>setOperatorName(e.target.value)}
              placeholder="Meno operátora"
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm"
            />
            <input
              value={orderNumber}
              onChange={(e)=>setOrderNumber(e.target.value)}
              placeholder="Číslo zákazky"
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm"
            />
            <input
              value={productNumber}
              onChange={(e)=>setProductNumber(e.target.value)}
              placeholder="Číslo produktu"
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm"
            />
            <button
              onClick={() => { localStorage.removeItem("etis_auth"); location.href = "/login"; }}
              className="text-sm text-slate-300 hover:text-white ml-2"
            >
              Odhlásiť
            </button>
          </div>
        </header>

        {/* Upload panel */}
        <div className="grid md:grid-cols-2 gap-6 print:hidden">
          {/* MASTER */}
          <div className="rounded-2xl bg-slate-800/60 border border-slate-700 p-5">
            <div className="text-sm font-semibold mb-2">Master etiketa</div>
            <input type="file" accept="image/*" onChange={onMaster} className="w-full" />
            {masterUrl && (
              <>
                <img src={masterUrl} alt="master" className="mt-3 rounded-lg border border-slate-700 max-h-64 mx-auto" />
                <div className="mt-3 flex items-center justify-center gap-2">
                  <button onClick={()=>rotateMaster(-90)} className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm">↺ 90°</button>
                  <button onClick={()=>rotateMaster(90)}  className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm">↻ 90°</button>
                  <button onClick={resetMasterRotation} className="px-3 py-1 rounded bg-slate-600 hover:bg-slate-500 text-sm">Reset</button>
                  <span className="text-slate-400 text-xs ml-2">uhoľ: {masterRot}°</span>
                </div>
              </>
            )}
          </div>

          {/* SCAN */}
          <div className="rounded-2xl bg-slate-800/60 border border-slate-700 p-5">
            <div className="text-sm font-semibold mb-2">Etiketa na porovnanie</div>
            <input type="file" accept="image/*" onChange={onEtiketa} className="w-full" />
            {etiketaUrl && (
              <>
                <img src={etiketaUrl} alt="etiketa" className="mt-3 rounded-lg border border-slate-700 max-h-64 mx-auto" />
                <div className="mt-3 flex items-center justify-center gap-2">
                  <button onClick={()=>rotateEtiketa(-90)} className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm">↺ 90°</button>
                  <button onClick={()=>rotateEtiketa(90)}  className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm">↻ 90°</button>
                  <button onClick={resetEtiketaRotation} className="px-3 py-1 rounded bg-slate-600 hover:bg-slate-500 text-sm">Reset</button>
                  <span className="text-slate-400 text-xs ml-2">uhoľ: {etiketaRot}°</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Tlačidlo Porovnať */}
        <div className="mt-6 print:hidden">
          <button
            onClick={doCompare}
            disabled={isComparing || !masterFile || !etiketaFile}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-6 py-3 rounded-xl"
          >
            {isComparing ? "Porovnávam…" : "Porovnať"}
          </button>
        </div>

        {/* Results */}
        {view ? (
          <div className="mt-8 grid md:grid-cols-[1.2fr_0.8fr] gap-8 items-start">
            {/* ĽAVÝ STĹPEC: náhľad + tlačidlá na SPODKU */}
            <div>
              <div className="rounded-2xl bg-white p-4 text-slate-900 border">
                <Overlay src={view.url} w={view.w} h={view.h} boxes={view.boxes || []} />
              </div>

              <div className="mt-4 flex items-center justify-between">
                <div className="text-sm text-slate-300">
                  {generatedAt ? `Report: ${generatedAt.toLocaleString()}` : null}
                </div>
                <div className="flex gap-3 print:hidden">
                  <button
                    onClick={saveReport}
                    className="bg-sky-600 hover:bg-sky-700 text-white font-semibold px-5 py-3 rounded-xl"
                  >
                    Uložiť
                  </button>
                  <button
                    onClick={printPage}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-5 py-3 rounded-xl"
                  >
                    Tlačiť
                  </button>
                </div>
              </div>
            </div>

            {/* PRAVÝ STĹPEC: vyhodnotenie */}
            <div className="rounded-2xl bg-slate-800/60 border border-slate-700 p-5 space-y-5">
              <h2 className="text-xl font-bold">Vyhodnotenie</h2>

              {/* Meta info pre tlač */}
              <div className="text-sm text-slate-300 hidden print:block">
                <div><b>Operátor:</b> {operatorName || "-"}</div>
                <div><b>Číslo zákazky:</b> {orderNumber || "-"}</div>
                <div><b>Číslo produktu:</b> {productNumber || "-"}</div>
                <div><b>Dátum/čas:</b> {generatedAt ? generatedAt.toLocaleString() : "-"}</div>
              </div>

              {/* OCR */}
              <div>
                <div className="flex items-center gap-2">
                  <b>OCR:</b>
                  {summary.ocr === "OK" ? <span className="text-green-400">OK</span> :
                   summary.ocr === "Chyba" ? <span className="text-red-400">Chyba</span> :
                   <span className="text-slate-300">–</span>}
                </div>

                {(view.ocrMaster || view.ocrScan) && (
                  <div className="text-sm mt-2 space-y-2">
                    <div>
                      <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-100 font-semibold mr-2">Master</span>
                      <span className="text-slate-300">{view.ocrMaster || "-"}</span>
                    </div>
                    <div>
                      <span className="px-2 py-0.5 rounded bg-emerald-700 text-white font-semibold mr-2">Scan</span>
                      <span className="text-slate-300">{view.ocrScan || "-"}</span>
                    </div>

                    {!!(view.ocrDiffs && view.ocrDiffs.length) && (
                      <div className="mt-3">
                        <div className="text-slate-400 mb-1">Rozdiely ({view.ocrDiffs.length}):</div>
                        <ul className="space-y-1 max-h-48 overflow-auto pr-1">
                          {view.ocrDiffs!.map((d, i) => (
                            <li key={i} className="bg-slate-900/50 rounded p-2 text-slate-200">
                              <div className="text-xs text-slate-400 mb-1">riadok {d.line}</div>
                              <div><span className="text-slate-400">M:</span> {d.master || <em className="text-slate-500">∅</em>}</div>
                              <div><span className="text-slate-400">S:</span> <span className="text-amber-300">{d.scan || <em className="text-slate-500">∅</em>}</span></div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* BARCODE */}
              <div>
                <div className="flex items-center gap-2">
                  <b>Čiarový kód:</b>
                  {summary.bc === "OK" ? <span className="text-green-400">OK</span> :
                   summary.bc === "Chyba" ? <span className="text-red-400">Chyba</span> :
                   <span className="text-slate-300">Bez kódu</span>}
                  {summary.bcMismatch && <span className="ml-2 text-red-300 text-sm">(nezhoda Master vs Scan)</span>}
                </div>

                {!!(view.barcode && view.barcode.length) && (
                  <ul className="text-sm text-slate-300 mt-2 space-y-1">
                    {view.barcode!.map((b, i) => (
                      <li key={i}>
                        {b.side ? <span className={`px-2 py-0.5 rounded mr-2 ${b.side==='master'?'bg-slate-700':'bg-emerald-700'} text-white`}>{b.side}</span> : null}
                        {b.symbology}: <span className="font-mono">{b.value}</span>{" "}
                        {b.valid ? <span className="text-green-400">(OK)</span> : <span className="text-red-400">(CHYBA{b.reason ? `: ${b.reason}` : ""})</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* GRAFIKA */}
              <div>
                <div className="flex items-center gap-2">
                  <b>Grafika:</b>
                  {summary.gfx === "OK" ? <span className="text-green-400">OK</span> :
                   summary.gfx === "Chyba" ? <span className="text-red-400">Chyba</span> :
                   <span className="text-slate-300">–</span>}
                  {view.boxes?.length ? (
                    <span className="text-sm text-slate-300">Nájdené rozdiely: {view.boxes.length}</span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-8 text-slate-300">Tu sa zobrazia výsledky.</p>
        )}
      </div>
    </div>
  );
}




