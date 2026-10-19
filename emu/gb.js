/* シム岡山用 Game Boy / Game Boy Color エミュレータ (自作・依存なし)
 * MBC5 / ROM only, CGB カラー, 倍速モード, HDMA, 4チャンネル音声 */
'use strict';
(function (root) {

const CYC = new Uint8Array([
1,3,2,2,1,1,2,1,5,2,2,2,1,1,2,1,
1,3,2,2,1,1,2,1,3,2,2,2,1,1,2,1,
2,3,2,2,1,1,2,1,2,2,2,2,1,1,2,1,
2,3,2,2,3,3,3,1,2,2,2,2,1,1,2,1,
1,1,1,1,1,1,2,1,1,1,1,1,1,1,2,1,
1,1,1,1,1,1,2,1,1,1,1,1,1,1,2,1,
1,1,1,1,1,1,2,1,1,1,1,1,1,1,2,1,
2,2,2,2,2,2,1,2,1,1,1,1,1,1,2,1,
1,1,1,1,1,1,2,1,1,1,1,1,1,1,2,1,
1,1,1,1,1,1,2,1,1,1,1,1,1,1,2,1,
1,1,1,1,1,1,2,1,1,1,1,1,1,1,2,1,
1,1,1,1,1,1,2,1,1,1,1,1,1,1,2,1,
2,3,3,4,3,4,2,4,2,4,3,1,3,6,2,4,
2,3,3,1,3,4,2,4,2,4,3,1,3,1,2,4,
3,3,2,1,1,4,2,4,4,1,4,1,1,1,2,4,
3,3,2,1,1,4,2,4,3,2,4,1,1,1,2,4]);

const DUTY = [[0,0,0,0,0,0,0,1],[1,0,0,0,0,0,0,1],[1,0,0,0,0,1,1,1],[0,1,1,1,1,1,1,0]];
const APU_MASK = [0x80,0x3F,0x00,0xFF,0xBF, 0xFF,0x3F,0x00,0xFF,0xBF, 0x7F,0xFF,0x9F,0xFF,0xBF, 0xFF,0xFF,0x00,0x00,0xBF, 0x00,0x00,0x70];

class GameBoy {
  constructor(romBytes, opts) {
    opts = opts || {};
    this.rom = romBytes instanceof Uint8Array ? romBytes : new Uint8Array(romBytes);
    const rom = this.rom;
    this.cgbFlag = rom[0x143];
    this.cgb = (this.cgbFlag & 0x80) !== 0 && !opts.forceDmg;
    this.cartType = rom[0x147];
    this.romBanks = Math.max(2, 1 << ((rom[0x148] & 0x0F) + 1));
    const ramCode = rom[0x149];
    this.ramSize = [0, 2048, 8192, 32768, 131072, 65536][ramCode] || 0;
    if (this.cartType >= 0x19 && this.cartType <= 0x1E && !this.ramSize) this.ramSize = 8192;
    this.sram = new Uint8Array(Math.max(this.ramSize, 8192));
    this.sramDirty = false;
    this.mbc = (this.cartType >= 0x19 && this.cartType <= 0x1E) ? 5 : (this.cartType >= 1 && this.cartType <= 3) ? 1 : 0;
    this.romBank = 1; this.romOff = 0x4000; this.ramBank = 0; this.ramOff = 0; this.ramEnable = false;
    this.mbc1Mode = 0; this.mbc1Hi = 0;

    this.vram = new Uint8Array(0x4000);
    this.wram = new Uint8Array(0x8000);
    this.oam = new Uint8Array(0xA0);
    this.hram = new Uint8Array(0x80);
    this.io = new Uint8Array(0x80);
    this.vbk = 0; this.svbk = 1; this.wramOff = 0x1000;
    this.bgPal = new Uint8Array(64); this.objPal = new Uint8Array(64);
    this.bgPal.fill(0xFF); this.objPal.fill(0xFF);
    this.bcps = 0; this.ocps = 0;
    this.ie = 0; this.iflag = 0xE1;

    // CPU
    this.a = this.cgb ? 0x11 : 0x01; this.b = 0; this.c = 0x13; this.d = 0; this.e = 0xD8; this.h = 0x01; this.l = 0x4D;
    if (this.cgb) { this.c = 0; this.d = 0xFF; this.e = 0x56; this.h = 0; this.l = 0x0D; }
    this.zf = 1; this.nf = 0; this.hf = this.cgb ? 0 : 1; this.cf = this.cgb ? 0 : 1;
    this.sp = 0xFFFE; this.pc = 0x100;
    this.ime = 0; this.imeDelay = 0; this.halted = false; this.haltBug = false;
    this.double = false; this.keyPrepare = false; this.halfCarry = 0;

    // timers
    this.divTotal = 0; this.tima = 0; this.tma = 0; this.tac = 0;

    // joypad
    this.buttons = 0; // bit0 A,1 B,2 Select,3 Start,4 Right,5 Left,6 Up,7 Down (1 = pressed)
    this.joypSel = 0x30;

    // PPU
    this.ly = 0; this.lineDots = 0; this.mode = 1; this.statLine = 0; this.lyc = 0;
    this.lcdc = 0x91; this.stat = 0; this.scy = 0; this.scx = 0; this.bgp = 0xFC; this.obp0 = 0xFF; this.obp1 = 0xFF; this.wy = 0; this.wx = 0;
    this.winLine = 0; this.frameDots = 0;
    this.fbBuf = new ArrayBuffer(160 * 144 * 4);
    this.back = new Uint32Array(this.fbBuf);
    this.frontBuf = new Uint8ClampedArray(160 * 144 * 4);
    this.front32 = new Uint32Array(this.frontBuf.buffer);
    this.back.fill(0xFFFFFFFF); this.front32.fill(0xFFFFFFFF);
    this.bgIdx = new Uint8Array(160); this.bgPrio = new Uint8Array(160); this.objDone = new Uint8Array(160);
    this.lcdOffCount = 0; this.frames = 0;
    this.colorLut = new Uint32Array(32768);
    this.setColorMode(opts.colorMode || 'lcd');
    this.dmgPalette = [0xFFD0F8E0, 0xFF70C088, 0xFF566834, 0xFF201808]; // ABGR little-endian (RGB 0xE0F8D0 …)

    // HDMA
    this.hdmaSrc = 0; this.hdmaDst = 0; this.hdmaLen = 0; this.hdmaActive = false;

    // APU
    this.sampleRate = opts.sampleRate || 44100;
    this.apuInit();

    // 初期 IO
    const io = this.io;
    io[0x40] = 0x91; io[0x47] = 0xFC; io[0x4D] = 0x7E; io[0x4F] = 0xFE; io[0x70] = 0xF8;
    this.lcdc = 0x91; this.bgp = 0xFC;
    this.apuWrite(0x26, 0xF1); this.apuWrite(0x24, 0x77); this.apuWrite(0x25, 0xF3);
    this.updateMode(true);
  }

  setColorMode(m) {
    this.colorMode = m;
    const lut = this.colorLut;
    for (let c = 0; c < 32768; c++) {
      let r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31, R, G, B;
      if (m === 'pyboy') { R = r << 3; G = g << 3; B = b << 3; }
      else if (m === 'raw') { R = (r << 3) | (r >> 2); G = (g << 3) | (g >> 2); B = (b << 3) | (b >> 2); }
      else { // 'lcd': 実機の液晶に近い混色 (Gambatte 系の補正)
        const rr = (r * 13 + g * 2 + b) >> 4, gg = (g * 3 + b) >> 2, bb = (r * 3 + g * 2 + b * 11) >> 4;
        R = (rr << 3) | (rr >> 2); G = (gg << 3) | (gg >> 2); B = (bb << 3) | (bb >> 2);
      }
      lut[c] = (0xFF000000 | (B << 16) | (G << 8) | R) >>> 0;
    }
  }

  /* ---------------- メモリ ---------------- */
  rb(a) {
    switch (a >> 12) {
      case 0: case 1: case 2: case 3: return this.rom[a];
      case 4: case 5: case 6: case 7: return this.rom[this.romOff + (a & 0x3FFF)];
      case 8: case 9: return this.vram[(this.vbk << 13) + (a & 0x1FFF)];
      case 0xA: case 0xB: return this.ramEnable ? this.sram[(this.ramOff + (a & 0x1FFF)) % this.sram.length] : 0xFF;
      case 0xC: return this.wram[a & 0xFFF];
      case 0xD: return this.wram[this.wramOff + (a & 0xFFF)];
      case 0xE: return this.wram[a & 0xFFF];
      default:
        if (a < 0xFE00) return this.wram[this.wramOff + (a & 0xFFF)];
        if (a < 0xFEA0) return this.oam[a - 0xFE00];
        if (a < 0xFF00) return 0xFF;
        if (a < 0xFF80) return this.ioRead(a & 0x7F);
        if (a === 0xFFFF) return this.ie;
        return this.hram[a & 0x7F];
    }
  }

  wb(a, v) {
    switch (a >> 12) {
      case 0: case 1:
        this.ramEnable = (v & 0x0F) === 0x0A; return;
      case 2:
        if (this.mbc === 5) { this.romBank = (this.romBank & 0x100) | v; this.updRom(); }
        else if (this.mbc === 1) { this.romBank = (v & 0x1F) || 1; this.updRom1(); }
        return;
      case 3:
        if (this.mbc === 5) { this.romBank = (this.romBank & 0xFF) | ((v & 1) << 8); this.updRom(); }
        else if (this.mbc === 1) { this.romBank = (v & 0x1F) || 1; this.updRom1(); }
        return;
      case 4: case 5:
        if (this.mbc === 5) { this.ramBank = v & 0x0F; this.ramOff = this.ramBank * 0x2000; }
        else if (this.mbc === 1) { this.mbc1Hi = v & 3; this.updRom1(); }
        return;
      case 6: case 7:
        if (this.mbc === 1) { this.mbc1Mode = v & 1; this.updRom1(); }
        return;
      case 8: case 9: this.vram[(this.vbk << 13) + (a & 0x1FFF)] = v; return;
      case 0xA: case 0xB:
        if (this.ramEnable) { this.sram[(this.ramOff + (a & 0x1FFF)) % this.sram.length] = v; this.sramDirty = true; }
        return;
      case 0xC: this.wram[a & 0xFFF] = v; return;
      case 0xD: this.wram[this.wramOff + (a & 0xFFF)] = v; return;
      case 0xE: this.wram[a & 0xFFF] = v; return;
      default:
        if (a < 0xFE00) { this.wram[this.wramOff + (a & 0xFFF)] = v; return; }
        if (a < 0xFEA0) { this.oam[a - 0xFE00] = v; return; }
        if (a < 0xFF00) return;
        if (a < 0xFF80) { this.ioWrite(a & 0x7F, v); return; }
        if (a === 0xFFFF) { this.ie = v; return; }
        this.hram[a & 0x7F] = v;
    }
  }
  updRom() { this.romOff = (this.romBank % this.romBanks) * 0x4000; }
  updRom1() {
    let b = this.romBank | (this.mbc1Hi << 5); if ((b & 0x1F) === 0) b |= 1;
    this.romOff = (b % this.romBanks) * 0x4000;
    this.ramOff = this.mbc1Mode ? this.mbc1Hi * 0x2000 : 0;
  }

  ioRead(r) {
    switch (r) {
      case 0x00: {
        let v = 0xC0 | this.joypSel | 0x0F, b = this.buttons;
        if (!(this.joypSel & 0x20)) v &= ~(b & 0x0F) ;
        if (!(this.joypSel & 0x10)) v &= ~((b >> 4) & 0x0F);
        return v & 0xFF;
      }
      case 0x04: return (this.divTotal >> 8) & 0xFF;
      case 0x05: return this.tima;
      case 0x06: return this.tma;
      case 0x07: return this.tac | 0xF8;
      case 0x0F: return this.iflag | 0xE0;
      case 0x40: return this.lcdc;
      case 0x41: return 0x80 | (this.stat & 0x78) | (this.lcdc & 0x80 ? ((this.ly === this.lyc ? 4 : 0) | this.mode) : 0);
      case 0x42: return this.scy;
      case 0x43: return this.scx;
      case 0x44: return this.ly;
      case 0x45: return this.lyc;
      case 0x47: return this.bgp;
      case 0x48: return this.obp0;
      case 0x49: return this.obp1;
      case 0x4A: return this.wy;
      case 0x4B: return this.wx;
      case 0x4D: return this.cgb ? ((this.double ? 0x80 : 0) | 0x7E | (this.keyPrepare ? 1 : 0)) : 0xFF;
      case 0x4F: return this.cgb ? (0xFE | this.vbk) : 0xFF;
      case 0x55: return this.cgb ? (this.hdmaActive ? ((this.hdmaLen - 1) & 0x7F) : 0xFF) : 0xFF;
      case 0x68: return this.cgb ? (this.bcps | 0x40) : 0xFF;
      case 0x69: return this.cgb ? this.bgPal[this.bcps & 0x3F] : 0xFF;
      case 0x6A: return this.cgb ? (this.ocps | 0x40) : 0xFF;
      case 0x6B: return this.cgb ? this.objPal[this.ocps & 0x3F] : 0xFF;
      case 0x70: return this.cgb ? (0xF8 | this.svbk) : 0xFF;
      default:
        if (r >= 0x10 && r <= 0x3F) return this.apuRead(r);
        return this.io[r];
    }
  }

  ioWrite(r, v) {
    switch (r) {
      case 0x00: this.joypSel = v & 0x30; return;
      case 0x04: this.divTotal = 0; return;
      case 0x05: this.tima = v; return;
      case 0x06: this.tma = v; return;
      case 0x07: this.tac = v & 7; return;
      case 0x0F: this.iflag = v & 0x1F; return;
      case 0x40: {
        const old = this.lcdc; this.lcdc = v;
        if ((old ^ v) & 0x80) {
          if (v & 0x80) { this.ly = 0; this.lineDots = 4; this.winLine = 0; this.updateMode(true); }
          else {
            this.lcdOffCount++; this.ly = 0; this.lineDots = 0; this.mode = 0; this.statLine = 0;
            this.back.fill(0xFFFFFFFF); this.front32.set(this.back);
          }
        }
        return;
      }
      case 0x41: this.stat = v & 0x78; this.updateStat(); return;
      case 0x42: this.scy = v; return;
      case 0x43: this.scx = v; return;
      case 0x44: return;
      case 0x45: this.lyc = v; this.updateStat(); return;
      case 0x46: { const s = v << 8; for (let i = 0; i < 160; i++) this.oam[i] = this.rb(s + i); return; }
      case 0x47: this.bgp = v; return;
      case 0x48: this.obp0 = v; return;
      case 0x49: this.obp1 = v; return;
      case 0x4A: this.wy = v; return;
      case 0x4B: this.wx = v; return;
      case 0x4D: if (this.cgb) this.keyPrepare = (v & 1) !== 0; return;
      case 0x4F: if (this.cgb) this.vbk = v & 1; return;
      case 0x51: this.hdmaSrc = (this.hdmaSrc & 0x00FF) | (v << 8); return;
      case 0x52: this.hdmaSrc = (this.hdmaSrc & 0xFF00) | (v & 0xF0); return;
      case 0x53: this.hdmaDst = (this.hdmaDst & 0x00FF) | ((v & 0x1F) << 8); return;
      case 0x54: this.hdmaDst = (this.hdmaDst & 0xFF00) | (v & 0xF0); return;
      case 0x55:
        if (!this.cgb) return;
        if (this.hdmaActive && !(v & 0x80)) { this.hdmaActive = false; return; }
        this.hdmaLen = (v & 0x7F) + 1;
        if (v & 0x80) { this.hdmaActive = true; }
        else { while (this.hdmaLen > 0) this.hdmaBlock(); }
        return;
      case 0x68: this.bcps = v; return;
      case 0x69: this.bgPal[this.bcps & 0x3F] = v; if (this.bcps & 0x80) this.bcps = 0x80 | ((this.bcps + 1) & 0x3F); return;
      case 0x6A: this.ocps = v; return;
      case 0x6B: this.objPal[this.ocps & 0x3F] = v; if (this.ocps & 0x80) this.ocps = 0x80 | ((this.ocps + 1) & 0x3F); return;
      case 0x70: if (this.cgb) { this.svbk = (v & 7) || 1; this.wramOff = this.svbk * 0x1000; } return;
      default:
        if (r >= 0x10 && r <= 0x3F) { this.apuWrite(r, v); return; }
        this.io[r] = v;
    }
  }

  hdmaBlock() {
    for (let i = 0; i < 16; i++) {
      this.vram[(this.vbk << 13) + ((this.hdmaDst + i) & 0x1FFF)] = this.rb((this.hdmaSrc + i) & 0xFFFF);
    }
    this.hdmaSrc = (this.hdmaSrc + 16) & 0xFFFF; this.hdmaDst = (this.hdmaDst + 16) & 0x1FFF;
    this.hdmaLen--;
    if (this.hdmaLen <= 0) this.hdmaActive = false;
  }

  /* ---------------- PPU ---------------- */
  updateStat() {
    if (!(this.lcdc & 0x80)) { this.statLine = 0; return; }
    const s = this.stat, m = this.mode;
    const line = ((s & 0x08) && m === 0) || ((s & 0x10) && m === 1) || ((s & 0x20) && m === 2) || ((s & 0x40) && this.ly === this.lyc) ? 1 : 0;
    if (line && !this.statLine) this.iflag |= 2;
    this.statLine = line;
  }
  updateMode(force) {
    let m;
    if (this.ly >= 144) m = 1;
    else if (this.lineDots < 80) m = 2;
    else if (this.lineDots < 252) m = 3;
    else m = 0;
    if (m !== this.mode || force) {
      const prev = this.mode;
      this.mode = m;
      if (m === 0 && (prev === 3 || prev === 2)) {
        this.renderLine();
        if (this.hdmaActive) this.hdmaBlock();
      }
      this.updateStat();
    }
  }
  ppuStep(dots) {
    this.frameDots += dots;
    if (!(this.lcdc & 0x80)) return;
    this.lineDots += dots;
    for (;;) {
      if (this.lineDots >= 456) {
        this.lineDots -= 456;
        this.ly++;
        if (this.ly === 144) {
          this.iflag |= 1; this.front32.set(this.back); this.frames++;
        } else if (this.ly >= 154) { this.ly = 0; this.winLine = 0; }
        this.updateMode(false); this.updateStat();
        continue;
      }
      break;
    }
    this.updateMode(false);
  }

  renderLine() {
    const ly = this.ly, lcdc = this.lcdc, cgb = this.cgb, vram = this.vram, out = this.back, base = ly * 160;
    const bgIdx = this.bgIdx, bgPrio = this.bgPrio, lut = this.colorLut;
    const bgPal = this.bgPal, objPal = this.objPal;
    let usedWindow = false;
    // 背景・ウィンドウ
    if (cgb || (lcdc & 1)) {
      const winOn = (lcdc & 0x20) && ly >= this.wy && this.wx <= 166;
      const mapBg = (lcdc & 8) ? 0x1C00 : 0x1800, mapWin = (lcdc & 0x40) ? 0x1C00 : 0x1800;
      const unsignedTiles = (lcdc & 0x10) !== 0;
      const scx = this.scx, py0 = (ly + this.scy) & 255, wxs = this.wx - 7;
      for (let x = 0; x < 160; x++) {
        let mapBase, px, py;
        if (winOn && x >= wxs) { mapBase = mapWin; px = x - wxs; py = this.winLine; usedWindow = true; }
        else { mapBase = mapBg; px = (x + scx) & 255; py = py0; }
        const mi = mapBase + ((py >> 3) << 5) + (px >> 3);
        const tile = vram[mi];
        const attr = cgb ? vram[0x2000 + mi] : 0;
        let line = py & 7; if (attr & 0x40) line = 7 - line;
        const taddr = (unsignedTiles ? tile * 16 : 0x1000 + ((tile << 24) >> 24) * 16) + line * 2 + ((attr & 8) ? 0x2000 : 0);
        const bit = (attr & 0x20) ? (px & 7) : 7 - (px & 7);
        const ci = (((vram[taddr + 1] >> bit) & 1) << 1) | ((vram[taddr] >> bit) & 1);
        bgIdx[x] = ci;
        if (cgb) {
          bgPrio[x] = (attr & 0x80) ? 1 : 0;
          const p = ((attr & 7) << 3) + (ci << 1);
          out[base + x] = lut[(bgPal[p] | (bgPal[p + 1] << 8)) & 0x7FFF];
        } else {
          bgPrio[x] = 0;
          out[base + x] = this.dmgPalette[(this.bgp >> (ci << 1)) & 3];
        }
      }
      if (usedWindow) this.winLine++;
    } else {
      for (let x = 0; x < 160; x++) { bgIdx[x] = 0; bgPrio[x] = 0; out[base + x] = this.dmgPalette[0]; }
    }
    // スプライト
    if (lcdc & 2) {
      const h = (lcdc & 4) ? 16 : 8, oam = this.oam, done = this.objDone;
      done.fill(0);
      let n = 0; const list = [];
      for (let i = 0; i < 40 && n < 10; i++) {
        const y = oam[i * 4] - 16;
        if (ly >= y && ly < y + h) { list.push(i); n++; }
      }
      if (!cgb) list.sort((p, q) => (oam[p * 4 + 1] - oam[q * 4 + 1]) || (p - q));
      const masterPrio = cgb && !(lcdc & 1);
      for (let k = 0; k < list.length; k++) {
        const i = list[k], y = oam[i * 4] - 16, sx = oam[i * 4 + 1] - 8;
        let tile = oam[i * 4 + 2]; const attr = oam[i * 4 + 3];
        let line = ly - y; if (attr & 0x40) line = h - 1 - line;
        if (h === 16) tile &= 0xFE;
        const addr = tile * 16 + line * 2 + (cgb && (attr & 8) ? 0x2000 : 0);
        const lo = vram[addr], hi = vram[addr + 1];
        for (let px = 0; px < 8; px++) {
          const x = sx + px; if (x < 0 || x >= 160) continue;
          const bit = (attr & 0x20) ? px : 7 - px;
          const ci = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
          if (!ci) continue;
          if (cgb) {
            if (done[x]) continue;
            if (!masterPrio && bgIdx[x] && (bgPrio[x] || (attr & 0x80))) continue;
            done[x] = 1;
            const p = ((attr & 7) << 3) + (ci << 1);
            out[base + x] = lut[(objPal[p] | (objPal[p + 1] << 8)) & 0x7FFF];
          } else {
            if ((attr & 0x80) && bgIdx[x]) continue;
            if (done[x]) continue;
            done[x] = 1;
            const pal = (attr & 0x10) ? this.obp1 : this.obp0;
            out[base + x] = this.dmgPalette[(pal >> (ci << 1)) & 3];
          }
        }
      }
    }
  }

  /* ---------------- APU ---------------- */
  apuInit() {
    this.apuOn = false;
    this.nr = new Uint8Array(0x30); // FF10..FF3F の生値
    this.wave = new Uint8Array(16);
    this.fsStep = 0; this.fsTimer = 8192;
    this.ch = [0, 1, 2, 3].map(() => ({ on: false, dac: false, len: 0, lenEn: false, timer: 0, pos: 0, vol: 0, envP: 0, envT: 0, envUp: false, freq: 0, duty: 0 }));
    this.sweep = { period: 0, shift: 0, neg: false, timer: 0, shadow: 0, enabled: false };
    this.lfsr = 0x7FFF; this.nsr = 0;
    this.sampleTimer = 0; this.sumL = 0; this.sumR = 0; this.accDots = 0;
    this.dotsPerSample = 4194304 / this.sampleRate;
    this.audioL = new Float32Array(32768); this.audioR = new Float32Array(32768);
    this.aw = 0; this.ar = 0; this.audioCount = 0; // リングバッファ
    this.masterGain = 0.22;
    this.muted = false;
  }
  apuRead(r) {
    if (r >= 0x30) { return this.wave[r - 0x30]; }
    if (r === 0x26) {
      let v = (this.apuOn ? 0x80 : 0) | 0x70;
      for (let i = 0; i < 4; i++) if (this.ch[i].on) v |= (1 << i);
      return v;
    }
    const i = r - 0x10;
    if (i < APU_MASK.length) return this.nr[i] | APU_MASK[i];
    return 0xFF;
  }
  apuWrite(r, v) {
    if (r >= 0x30) { this.wave[r - 0x30] = v; return; }
    if (r === 0x26) {
      const on = (v & 0x80) !== 0;
      if (!on && this.apuOn) { for (let i = 0; i < 0x16; i++) this.nr[i] = 0; for (const c of this.ch) { c.on = false; c.dac = false; c.lenEn = false; c.len = 0; c.vol = 0; } }
      if (on && !this.apuOn) { this.fsStep = 0; this.fsTimer = 8192; }
      this.apuOn = on; return;
    }
    if (!this.apuOn) { return; }
    const i = r - 0x10; if (i < 0 || i >= 0x16) return;
    this.nr[i] = v;
    const ch = this.ch;
    switch (r) {
      case 0x10: this.sweep.period = (v >> 4) & 7; this.sweep.neg = (v & 8) !== 0; this.sweep.shift = v & 7; break;
      case 0x11: ch[0].duty = v >> 6; ch[0].len = 64 - (v & 63); break;
      case 0x12: ch[0].dac = (v & 0xF8) !== 0; if (!ch[0].dac) ch[0].on = false; break;
      case 0x13: ch[0].freq = (ch[0].freq & 0x700) | v; break;
      case 0x14: ch[0].freq = (ch[0].freq & 0xFF) | ((v & 7) << 8); this.lenEn(ch[0], v, 64); if (v & 0x80) this.trigger(0); break;
      case 0x16: ch[1].duty = v >> 6; ch[1].len = 64 - (v & 63); break;
      case 0x17: ch[1].dac = (v & 0xF8) !== 0; if (!ch[1].dac) ch[1].on = false; break;
      case 0x18: ch[1].freq = (ch[1].freq & 0x700) | v; break;
      case 0x19: ch[1].freq = (ch[1].freq & 0xFF) | ((v & 7) << 8); this.lenEn(ch[1], v, 64); if (v & 0x80) this.trigger(1); break;
      case 0x1A: ch[2].dac = (v & 0x80) !== 0; if (!ch[2].dac) ch[2].on = false; break;
      case 0x1B: ch[2].len = 256 - v; break;
      case 0x1D: ch[2].freq = (ch[2].freq & 0x700) | v; break;
      case 0x1E: ch[2].freq = (ch[2].freq & 0xFF) | ((v & 7) << 8); this.lenEn(ch[2], v, 256); if (v & 0x80) this.trigger(2); break;
      case 0x20: ch[3].len = 64 - (v & 63); break;
      case 0x21: ch[3].dac = (v & 0xF8) !== 0; if (!ch[3].dac) ch[3].on = false; break;
      case 0x22: this.nsr = v; break;
      case 0x23: this.lenEn(ch[3], v, 64); if (v & 0x80) this.trigger(3); break;
    }
  }
  lenEn(c, v, max) {
    const was = c.lenEn; c.lenEn = (v & 0x40) !== 0;
    // 長さカウンタのエクストラクロック
    if (!was && c.lenEn && c.len > 0 && (this.fsStep & 1) === 1) { c.len--; if (c.len === 0 && !(v & 0x80)) c.on = false; }
  }
  trigger(n) {
    const c = this.ch[n];
    c.on = c.dac;
    if (n === 2) { if (c.len === 0) c.len = 256; c.timer = (2048 - c.freq) * 2; c.pos = 0; }
    else { if (c.len === 0) c.len = 64; }
    if (n === 0 || n === 1) {
      c.timer = (2048 - c.freq) * 4;
    }
    if (n === 3) { c.timer = this.noisePeriod(); this.lfsr = 0x7FFF; }
    if (n !== 2) {
      const reg = this.nr[n === 0 ? 2 : n === 1 ? 7 : 0x11];
      c.vol = reg >> 4; c.envUp = (reg & 8) !== 0; c.envP = reg & 7; c.envT = c.envP || 8;
    }
    if (n === 0) {
      const s = this.sweep; s.shadow = c.freq; s.timer = s.period || 8; s.enabled = s.period > 0 || s.shift > 0;
      if (s.shift > 0) this.sweepCalc();
    }
  }
  noisePeriod() {
    const r = this.nsr & 7, s = this.nsr >> 4;
    return ((r ? r * 16 : 8) << s);
  }
  sweepCalc() {
    const s = this.sweep, d = s.shadow >> s.shift;
    const nf = s.neg ? s.shadow - d : s.shadow + d;
    if (nf > 2047) this.ch[0].on = false;
    return nf;
  }
  fsClock() {
    const st = this.fsStep, ch = this.ch;
    if ((st & 1) === 0) { for (let i = 0; i < 4; i++) { const c = ch[i]; if (c.lenEn && c.len > 0) { c.len--; if (c.len === 0) c.on = false; } } }
    if (st === 2 || st === 6) {
      const s = this.sweep;
      if (--s.timer <= 0) {
        s.timer = s.period || 8;
        if (s.enabled && s.period > 0) {
          const nf = this.sweepCalc();
          if (nf <= 2047 && s.shift > 0) { s.shadow = nf; ch[0].freq = nf; this.sweepCalc(); }
        }
      }
    }
    if (st === 7) {
      for (const i of [0, 1, 3]) {
        const c = ch[i];
        if (c.envP) { if (--c.envT <= 0) { c.envT = c.envP; if (c.envUp) { if (c.vol < 15) c.vol++; } else if (c.vol > 0) c.vol--; } }
      }
    }
    this.fsStep = (st + 1) & 7;
  }
  apuStep(dots) {
    if (!this.apuOn) {
      // 電源オフでも無音サンプルは出力する
      this.sampleTimer -= dots;
      while (this.sampleTimer <= 0) { this.sampleTimer += this.dotsPerSample; this.pushSample(0, 0); }
      return;
    }
    const ch = this.ch;
    this.fsTimer -= dots;
    while (this.fsTimer <= 0) { this.fsTimer += 8192; this.fsClock(); }
    // チャンネルのタイマー
    for (let n = 0; n < 2; n++) {
      const c = ch[n];
      c.timer -= dots;
      if (c.timer <= 0) { const per = (2048 - c.freq) * 4 || 4; const k = Math.floor(-c.timer / per) + 1; c.pos = (c.pos + k) & 7; c.timer += k * per; }
    }
    { const c = ch[2]; c.timer -= dots; if (c.timer <= 0) { const per = (2048 - c.freq) * 2 || 2; const k = Math.floor(-c.timer / per) + 1; c.pos = (c.pos + k) & 31; c.timer += k * per; } }
    { const c = ch[3]; c.timer -= dots;
      while (c.timer <= 0) {
        c.timer += this.noisePeriod();
        const x = (this.lfsr & 1) ^ ((this.lfsr >> 1) & 1);
        this.lfsr = (this.lfsr >> 1) | (x << 14);
        if (this.nsr & 8) this.lfsr = (this.lfsr & ~0x40) | (x << 6);
      } }
    // ミックス
    const nr51 = this.nr[0x15], nr50 = this.nr[0x14];
    let L = 0, R = 0;
    for (let n = 0; n < 4; n++) {
      const c = ch[n]; if (!c.on || !c.dac) continue;
      let d;
      if (n < 2) d = DUTY[c.duty][c.pos] ? c.vol : 0;
      else if (n === 2) {
        const s = (this.wave[c.pos >> 1] >> ((c.pos & 1) ? 0 : 4)) & 15;
        const vs = (this.nr[0x0C] >> 5) & 3; d = vs === 0 ? 0 : s >> (vs - 1);
      } else d = (this.lfsr & 1) ? 0 : c.vol;
      const a = d / 7.5 - 1;
      if (nr51 & (1 << n)) R += a;
      if (nr51 & (0x10 << n)) L += a;
    }
    L *= ((nr50 >> 4) & 7) + 1; R *= (nr50 & 7) + 1;
    this.sumL += L * dots; this.sumR += R * dots; this.accDots += dots;
    this.sampleTimer -= dots;
    if (this.sampleTimer <= 0) {
      this.sampleTimer += this.dotsPerSample;
      const k = this.accDots > 0 ? 1 / this.accDots : 0;
      this.pushSample(this.sumL * k, this.sumR * k);
      this.sumL = this.sumR = this.accDots = 0;
    }
  }
  pushSample(l, r) {
    const g = this.muted ? 0 : this.masterGain / 8;
    const size = 32768;
    this.audioL[this.aw] = l * g; this.audioR[this.aw] = r * g;
    this.aw = (this.aw + 1) & (size - 1);
    if (this.audioCount < size) this.audioCount++; else this.ar = (this.ar + 1) & (size - 1);
  }
  /* 出力バッファへ読み出し */
  readAudio(outL, outR, n) {
    const size = 32768; let i = 0;
    while (i < n && this.audioCount > 0) {
      outL[i] = this.audioL[this.ar]; outR[i] = this.audioR[this.ar];
      this.ar = (this.ar + 1) & (size - 1); this.audioCount--; i++;
    }
    return i;
  }

  /* ---------------- CPU ---------------- */
  getF() { return (this.zf << 7) | (this.nf << 6) | (this.hf << 5) | (this.cf << 4); }
  setF(v) { this.zf = (v >> 7) & 1; this.nf = (v >> 6) & 1; this.hf = (v >> 5) & 1; this.cf = (v >> 4) & 1; }
  fetch() { const v = this.rb(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const lo = this.rb(this.pc), hi = this.rb((this.pc + 1) & 0xFFFF); this.pc = (this.pc + 2) & 0xFFFF; return lo | (hi << 8); }
  push16(v) { this.sp = (this.sp - 1) & 0xFFFF; this.wb(this.sp, v >> 8); this.sp = (this.sp - 1) & 0xFFFF; this.wb(this.sp, v & 0xFF); }
  pop16() { const lo = this.rb(this.sp); this.sp = (this.sp + 1) & 0xFFFF; const hi = this.rb(this.sp); this.sp = (this.sp + 1) & 0xFFFF; return lo | (hi << 8); }
  getR(i) {
    switch (i) { case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return this.h; case 5: return this.l; case 6: return this.rb((this.h << 8) | this.l); default: return this.a; }
  }
  setR(i, v) {
    switch (i) { case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: this.h = v; break; case 5: this.l = v; break; case 6: this.wb((this.h << 8) | this.l, v); break; default: this.a = v; }
  }
  alu(op, v) {
    const a = this.a;
    switch (op) {
      case 0: { const r = a + v; this.hf = ((a & 15) + (v & 15)) > 15 ? 1 : 0; this.cf = r > 255 ? 1 : 0; this.a = r & 255; this.zf = this.a === 0 ? 1 : 0; this.nf = 0; break; }
      case 1: { const c = this.cf, r = a + v + c; this.hf = ((a & 15) + (v & 15) + c) > 15 ? 1 : 0; this.cf = r > 255 ? 1 : 0; this.a = r & 255; this.zf = this.a === 0 ? 1 : 0; this.nf = 0; break; }
      case 2: { const r = a - v; this.hf = (a & 15) < (v & 15) ? 1 : 0; this.cf = r < 0 ? 1 : 0; this.a = r & 255; this.zf = this.a === 0 ? 1 : 0; this.nf = 1; break; }
      case 3: { const c = this.cf, r = a - v - c; this.hf = ((a & 15) - (v & 15) - c) < 0 ? 1 : 0; this.cf = r < 0 ? 1 : 0; this.a = r & 255; this.zf = this.a === 0 ? 1 : 0; this.nf = 1; break; }
      case 4: this.a = a & v; this.zf = this.a === 0 ? 1 : 0; this.nf = 0; this.hf = 1; this.cf = 0; break;
      case 5: this.a = a ^ v; this.zf = this.a === 0 ? 1 : 0; this.nf = 0; this.hf = 0; this.cf = 0; break;
      case 6: this.a = a | v; this.zf = this.a === 0 ? 1 : 0; this.nf = 0; this.hf = 0; this.cf = 0; break;
      default: { const r = a - v; this.hf = (a & 15) < (v & 15) ? 1 : 0; this.cf = r < 0 ? 1 : 0; this.zf = (r & 255) === 0 ? 1 : 0; this.nf = 1; }
    }
  }
  cb(op) {
    const r = op & 7, bit = (op >> 3) & 7;
    let v = this.getR(r), res;
    switch (op >> 6) {
      case 0: {
        switch (bit) {
          case 0: this.cf = v >> 7; res = ((v << 1) | this.cf) & 255; break;           // RLC
          case 1: this.cf = v & 1; res = (v >> 1) | (this.cf << 7); break;              // RRC
          case 2: { const c = this.cf; this.cf = v >> 7; res = ((v << 1) | c) & 255; break; } // RL
          case 3: { const c = this.cf; this.cf = v & 1; res = (v >> 1) | (c << 7); break; }   // RR
          case 4: this.cf = v >> 7; res = (v << 1) & 255; break;                         // SLA
          case 5: this.cf = v & 1; res = (v >> 1) | (v & 0x80); break;                   // SRA
          case 6: res = ((v << 4) | (v >> 4)) & 255; this.cf = 0; break;                 // SWAP
          default: this.cf = v & 1; res = v >> 1;                                        // SRL
        }
        this.zf = res === 0 ? 1 : 0; this.nf = 0; this.hf = 0; this.setR(r, res); break;
      }
      case 1: this.zf = (v >> bit) & 1 ? 0 : 1; this.nf = 0; this.hf = 1; break;
      case 2: this.setR(r, v & ~(1 << bit) & 255); break;
      default: this.setR(r, v | (1 << bit));
    }
    return r === 6 ? ((op >> 6) === 1 ? 3 : 4) : 2;
  }

  /* 1命令実行して CPU サイクル(M)を返す */
  stepCpu() {
    // 割り込み
    if (this.imeDelay) { if (--this.imeDelay === 0) this.ime = 1; }
    const pend = this.iflag & this.ie & 0x1F;
    if (this.halted) {
      if (pend) { this.halted = false; } else return 1;
    }
    if (this.ime && pend) {
      this.ime = 0; this.halted = false;
      let n = 0; while (!((pend >> n) & 1)) n++;
      this.iflag &= ~(1 << n);
      this.push16(this.pc); this.pc = 0x40 + n * 8;
      return 5;
    }
    const op = this.fetch();
    if (this.haltBug) { this.pc = (this.pc - 1) & 0xFFFF; this.haltBug = false; }
    let cy = CYC[op];
    switch (op) {
      case 0x00: break;
      case 0x01: { const v = this.fetch16(); this.b = v >> 8; this.c = v & 255; break; }
      case 0x11: { const v = this.fetch16(); this.d = v >> 8; this.e = v & 255; break; }
      case 0x21: { const v = this.fetch16(); this.h = v >> 8; this.l = v & 255; break; }
      case 0x31: this.sp = this.fetch16(); break;
      case 0x02: this.wb((this.b << 8) | this.c, this.a); break;
      case 0x12: this.wb((this.d << 8) | this.e, this.a); break;
      case 0x22: { let hl = (this.h << 8) | this.l; this.wb(hl, this.a); hl = (hl + 1) & 0xFFFF; this.h = hl >> 8; this.l = hl & 255; break; }
      case 0x32: { let hl = (this.h << 8) | this.l; this.wb(hl, this.a); hl = (hl - 1) & 0xFFFF; this.h = hl >> 8; this.l = hl & 255; break; }
      case 0x0A: this.a = this.rb((this.b << 8) | this.c); break;
      case 0x1A: this.a = this.rb((this.d << 8) | this.e); break;
      case 0x2A: { let hl = (this.h << 8) | this.l; this.a = this.rb(hl); hl = (hl + 1) & 0xFFFF; this.h = hl >> 8; this.l = hl & 255; break; }
      case 0x3A: { let hl = (this.h << 8) | this.l; this.a = this.rb(hl); hl = (hl - 1) & 0xFFFF; this.h = hl >> 8; this.l = hl & 255; break; }
      case 0x03: { const v = (((this.b << 8) | this.c) + 1) & 0xFFFF; this.b = v >> 8; this.c = v & 255; break; }
      case 0x13: { const v = (((this.d << 8) | this.e) + 1) & 0xFFFF; this.d = v >> 8; this.e = v & 255; break; }
      case 0x23: { const v = (((this.h << 8) | this.l) + 1) & 0xFFFF; this.h = v >> 8; this.l = v & 255; break; }
      case 0x33: this.sp = (this.sp + 1) & 0xFFFF; break;
      case 0x0B: { const v = (((this.b << 8) | this.c) - 1) & 0xFFFF; this.b = v >> 8; this.c = v & 255; break; }
      case 0x1B: { const v = (((this.d << 8) | this.e) - 1) & 0xFFFF; this.d = v >> 8; this.e = v & 255; break; }
      case 0x2B: { const v = (((this.h << 8) | this.l) - 1) & 0xFFFF; this.h = v >> 8; this.l = v & 255; break; }
      case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; break;
      case 0x04: case 0x0C: case 0x14: case 0x1C: case 0x24: case 0x2C: case 0x34: case 0x3C: {
        const r = op >> 3, v = (this.getR(r) + 1) & 255; this.hf = (v & 15) === 0 ? 1 : 0; this.zf = v === 0 ? 1 : 0; this.nf = 0; this.setR(r, v); break; }
      case 0x05: case 0x0D: case 0x15: case 0x1D: case 0x25: case 0x2D: case 0x35: case 0x3D: {
        const r = op >> 3, v = (this.getR(r) - 1) & 255; this.hf = (v & 15) === 15 ? 1 : 0; this.zf = v === 0 ? 1 : 0; this.nf = 1; this.setR(r, v); break; }
      case 0x06: case 0x0E: case 0x16: case 0x1E: case 0x26: case 0x2E: case 0x36: case 0x3E: this.setR(op >> 3, this.fetch()); break;
      case 0x07: this.cf = this.a >> 7; this.a = ((this.a << 1) | this.cf) & 255; this.zf = 0; this.nf = 0; this.hf = 0; break;
      case 0x0F: this.cf = this.a & 1; this.a = (this.a >> 1) | (this.cf << 7); this.zf = 0; this.nf = 0; this.hf = 0; break;
      case 0x17: { const c = this.cf; this.cf = this.a >> 7; this.a = ((this.a << 1) | c) & 255; this.zf = 0; this.nf = 0; this.hf = 0; break; }
      case 0x1F: { const c = this.cf; this.cf = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.zf = 0; this.nf = 0; this.hf = 0; break; }
      case 0x08: { const a = this.fetch16(); this.wb(a, this.sp & 255); this.wb((a + 1) & 0xFFFF, this.sp >> 8); break; }
      case 0x09: case 0x19: case 0x29: case 0x39: {
        const hl = (this.h << 8) | this.l;
        const v = op === 0x09 ? (this.b << 8) | this.c : op === 0x19 ? (this.d << 8) | this.e : op === 0x29 ? hl : this.sp;
        const r = hl + v; this.hf = ((hl & 0xFFF) + (v & 0xFFF)) > 0xFFF ? 1 : 0; this.cf = r > 0xFFFF ? 1 : 0; this.nf = 0;
        this.h = (r >> 8) & 255; this.l = r & 255; break; }
      case 0x10: // STOP
        this.fetch();
        if (this.cgb && this.keyPrepare) { this.double = !this.double; this.keyPrepare = false; this.divTotal = 0; }
        break;
      case 0x18: { const e = (this.fetch() << 24) >> 24; this.pc = (this.pc + e) & 0xFFFF; break; }
      case 0x20: case 0x28: case 0x30: case 0x38: {
        const e = (this.fetch() << 24) >> 24;
        const t = op === 0x20 ? !this.zf : op === 0x28 ? this.zf : op === 0x30 ? !this.cf : this.cf;
        if (t) { this.pc = (this.pc + e) & 0xFFFF; cy++; } break; }
      case 0x27: { // DAA
        let a = this.a;
        if (!this.nf) { if (this.cf || a > 0x99) { a += 0x60; this.cf = 1; } if (this.hf || (a & 15) > 9) a += 6; }
        else { if (this.cf) a -= 0x60; if (this.hf) a -= 6; }
        this.a = a & 255; this.zf = this.a === 0 ? 1 : 0; this.hf = 0; break; }
      case 0x2F: this.a ^= 255; this.nf = 1; this.hf = 1; break;
      case 0x37: this.cf = 1; this.nf = 0; this.hf = 0; break;
      case 0x3F: this.cf ^= 1; this.nf = 0; this.hf = 0; break;
      case 0x76:
        if (!this.ime && (this.iflag & this.ie & 0x1F)) this.haltBug = true; else this.halted = true;
        break;
      case 0xC0: case 0xC8: case 0xD0: case 0xD8: {
        const t = op === 0xC0 ? !this.zf : op === 0xC8 ? this.zf : op === 0xD0 ? !this.cf : this.cf;
        if (t) { this.pc = this.pop16(); cy += 3; } break; }
      case 0xC9: this.pc = this.pop16(); break;
      case 0xD9: this.pc = this.pop16(); this.ime = 1; break;
      case 0xC1: { const v = this.pop16(); this.b = v >> 8; this.c = v & 255; break; }
      case 0xD1: { const v = this.pop16(); this.d = v >> 8; this.e = v & 255; break; }
      case 0xE1: { const v = this.pop16(); this.h = v >> 8; this.l = v & 255; break; }
      case 0xF1: { const v = this.pop16(); this.a = v >> 8; this.setF(v & 0xF0); break; }
      case 0xC5: this.push16((this.b << 8) | this.c); break;
      case 0xD5: this.push16((this.d << 8) | this.e); break;
      case 0xE5: this.push16((this.h << 8) | this.l); break;
      case 0xF5: this.push16((this.a << 8) | this.getF()); break;
      case 0xC2: case 0xCA: case 0xD2: case 0xDA: {
        const a = this.fetch16();
        const t = op === 0xC2 ? !this.zf : op === 0xCA ? this.zf : op === 0xD2 ? !this.cf : this.cf;
        if (t) { this.pc = a; cy++; } break; }
      case 0xC3: this.pc = this.fetch16(); break;
      case 0xE9: this.pc = (this.h << 8) | this.l; break;
      case 0xC4: case 0xCC: case 0xD4: case 0xDC: {
        const a = this.fetch16();
        const t = op === 0xC4 ? !this.zf : op === 0xCC ? this.zf : op === 0xD4 ? !this.cf : this.cf;
        if (t) { this.push16(this.pc); this.pc = a; cy += 3; } break; }
      case 0xCD: { const a = this.fetch16(); this.push16(this.pc); this.pc = a; break; }
      case 0xC7: case 0xCF: case 0xD7: case 0xDF: case 0xE7: case 0xEF: case 0xF7: case 0xFF:
        this.push16(this.pc); this.pc = op & 0x38; break;
      case 0xCB: { const o = this.fetch(); cy = this.cb(o); break; }
      case 0xE0: this.wb(0xFF00 | this.fetch(), this.a); break;
      case 0xF0: this.a = this.rb(0xFF00 | this.fetch()); break;
      case 0xE2: this.wb(0xFF00 | this.c, this.a); break;
      case 0xF2: this.a = this.rb(0xFF00 | this.c); break;
      case 0xEA: this.wb(this.fetch16(), this.a); break;
      case 0xFA: this.a = this.rb(this.fetch16()); break;
      case 0xE8: { const e = (this.fetch() << 24) >> 24, sp = this.sp;
        this.hf = ((sp & 15) + (e & 15)) > 15 ? 1 : 0; this.cf = ((sp & 255) + (e & 255)) > 255 ? 1 : 0; this.zf = 0; this.nf = 0;
        this.sp = (sp + e) & 0xFFFF; break; }
      case 0xF8: { const e = (this.fetch() << 24) >> 24, sp = this.sp;
        this.hf = ((sp & 15) + (e & 15)) > 15 ? 1 : 0; this.cf = ((sp & 255) + (e & 255)) > 255 ? 1 : 0; this.zf = 0; this.nf = 0;
        const v = (sp + e) & 0xFFFF; this.h = v >> 8; this.l = v & 255; break; }
      case 0xF9: this.sp = (this.h << 8) | this.l; break;
      case 0xF3: this.ime = 0; this.imeDelay = 0; break;
      case 0xFB: if (!this.ime) this.imeDelay = 2; break;
      case 0xC6: this.alu(0, this.fetch()); break;
      case 0xCE: this.alu(1, this.fetch()); break;
      case 0xD6: this.alu(2, this.fetch()); break;
      case 0xDE: this.alu(3, this.fetch()); break;
      case 0xE6: this.alu(4, this.fetch()); break;
      case 0xEE: this.alu(5, this.fetch()); break;
      case 0xF6: this.alu(6, this.fetch()); break;
      case 0xFE: this.alu(7, this.fetch()); break;
      default:
        if (op >= 0x40 && op < 0x80) this.setR((op >> 3) & 7, this.getR(op & 7));
        else if (op >= 0x80 && op < 0xC0) this.alu((op >> 3) & 7, this.getR(op & 7));
        // 未定義オペコードは何もしない
    }
    return cy;
  }

  /* 1 フレーム (70224 ドット) 実行 */
  runFrame() {
    const target = 70224;
    while (this.frameDots < target) {
      const cy = this.stepCpu();
      const cpuCycles = cy * 4;
      // タイマー (CPU クロック)
      if (this.tac & 4) {
        const b = [9, 3, 5, 7][this.tac & 3], k = b + 1;
        const o = this.divTotal; this.divTotal = o + cpuCycles;
        let n = (this.divTotal >> k) - (o >> k);
        while (n-- > 0) { if (++this.tima > 255) { this.tima = this.tma; this.iflag |= 4; } }
      } else this.divTotal += cpuCycles;
      if (this.divTotal > 0x3FFFFFFF) this.divTotal &= 0xFFFF;
      // PPU / APU (通常速度ドット)
      let dots = cpuCycles;
      if (this.double) { this.halfCarry += cpuCycles; dots = this.halfCarry >> 1; this.halfCarry &= 1; }
      if (dots) { this.ppuStep(dots); this.apuStep(dots); }
    }
    this.frameDots -= target;
    if (!(this.lcdc & 0x80)) { this.front32.set(this.back); }
  }

  /* セーブ */
  getSave() { return this.sram.slice(0, Math.max(this.ramSize, 0) || 0); }
  loadSave(bytes) { if (!bytes) return; this.sram.set(bytes.subarray(0, Math.min(bytes.length, this.sram.length))); }
  setButtons(mask) { this.buttons = mask; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { GameBoy };
else root.GameBoy = GameBoy;
})(typeof window !== 'undefined' ? window : globalThis);
