// WebGL hero: the trainer's photo drawn through one small shader tinted with their brand.
//   mode 0 (energy)  duotone, page black to brand, slow liquid drift, touch ripple
//   mode 1 (studio)  natural photo, a brand aurora rising from the bottom
//   mode 2 (luxe)    soft desaturated photo, breathing light, brand tint
// Falls back to a plain <img> without WebGL or when the image blocks CORS.
// Pauses offscreen and in background tabs; a single still frame under reduced motion.
import { useEffect, useRef, useState } from 'react';
import { hexToRgb } from './theme.ts';

export interface HeroGLProps {
  src?: string;
  brand: string;
  accent: string;
  base: string; // page background, the shader fades into it
  mode: 0 | 1 | 2;
  speed: number;
  grain: number;
  strength: number;
  fade: number; // 1 = bottom fades into the page (text sits on the photo)
  alt: string;
  className?: string;
}

const VERT = `attribute vec2 p; varying vec2 vUv; void main() { vUv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform vec2 uRes, uImg, uPtr;
uniform float uTime, uAmt, uMode, uGrain, uStrength, uFade;
uniform vec3 uBrand, uAccent, uBase;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0., a = .5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 1.7; a *= .5; }
  return v;
}
// object-fit: cover for the photo
vec2 cover(vec2 uv) {
  float rs = uRes.x / uRes.y, ri = uImg.x / uImg.y;
  vec2 s = rs > ri ? vec2(1., ri / rs) : vec2(rs / ri, 1.);
  return (uv - .5) * s + .5;
}

void main() {
  vec2 uv = vUv;
  vec2 d = uv - uPtr;
  d.x *= uRes.x / uRes.y;
  float dist = length(d);
  float ripple = uAmt * exp(-dist * 5.) * sin(dist * 26. - uTime * 7.);
  vec2 flow = vec2(fbm(uv * 2.6 + uTime * .12), fbm(uv * 2.6 + 9.2 - uTime * .1)) - .5;
  vec2 st = cover(uv + flow * .014 * uStrength + d * ripple * .03);
  vec3 img = texture2D(uTex, clamp(st, .001, .999)).rgb;
  float lum = dot(img, vec3(.299, .587, .114));
  vec3 col;
  if (uMode < .5) {
    float l = smoothstep(.06, .9, lum);
    col = mix(uBase, uBrand, pow(l, 1.35));
    float heat = smoothstep(.58, .92, fbm(uv * 1.8 + vec2(uTime * .18, -uTime * .09)));
    col = mix(col, uAccent, heat * .22 * uStrength * l);
  } else if (uMode < 1.5) {
    float rise = smoothstep(0., .75, 1. - uv.y);
    float a = rise * (.3 + .5 * fbm(uv * 1.7 + uTime * .08));
    vec3 aurora = mix(uBrand, uAccent, fbm(uv * 1.2 - uTime * .06));
    col = mix(img, aurora, a * .5 * uStrength);
  } else {
    vec3 soft = mix(vec3(lum), img, .5);
    float breath = .5 + .5 * sin(uTime * .6 + uv.x * 1.3 + uv.y * .7);
    col = mix(soft, soft * (.72 + .6 * uBrand), .35 * uStrength) + breath * .05;
  }
  col = mix(uBase, col, mix(1., smoothstep(0., .55, uv.y), uFade));
  col += (hash(uv * uRes + fract(uTime) * 97.) - .5) * uGrain;
  gl_FragColor = vec4(col, 1.);
}`;

const rgb = (hex: string) => hexToRgb(hex).map((v) => v / 255) as [number, number, number];

function compile(gl: WebGLRenderingContext): WebGLProgram | null {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('HeroGL: shader failed, using the plain photo', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT);
  const fs = shader(gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

export function HeroGL(props: HeroGLProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  // Latest colors live in a ref: recoloring (demo brand preview) never rebuilds the GL context.
  const live = useRef(props);
  live.current = props;
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const el = canvas.current;
    if (!el || !props.src) return;
    const gl = el.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' });
    const program = gl && compile(gl);
    if (!gl || !program) {
      setFailed(true);
      return;
    }
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let disposed = false;
    let ready = false;
    let visible = true;
    let raf = 0;
    let clock = 3;
    let last = performance.now();
    const ptr = { x: 0.5, y: 0.5, amt: 0 };

    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const attr = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string) => gl.getUniformLocation(program, name);
    const U = {
      res: u('uRes'), img: u('uImg'), ptr: u('uPtr'), time: u('uTime'), amt: u('uAmt'), mode: u('uMode'),
      grain: u('uGrain'), strength: u('uStrength'), fade: u('uFade'), brand: u('uBrand'), accent: u('uAccent'), base: u('uBase'),
    };

    const texture = gl.createTexture();
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      if (disposed) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      } catch (e) {
        console.warn('HeroGL: photo not usable as a texture (CORS), using the plain photo', e);
        setFailed(true);
        return;
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform2f(U.img, image.naturalWidth, image.naturalHeight);
      ready = true;
      el.dataset.ready = 'true';
      draw(performance.now());
    };
    image.onerror = () => setFailed(true);
    image.src = props.src;

    function draw(now: number) {
      if (!ready || disposed || !el || !gl) return;
      const p = live.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!reduce) clock += dt * p.speed;
      ptr.amt *= 0.94;
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(el.clientWidth * dpr));
      const h = Math.max(1, Math.round(el.clientHeight * dpr));
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(U.res, w, h);
      gl.uniform2f(U.ptr, ptr.x, ptr.y);
      gl.uniform1f(U.time, clock);
      gl.uniform1f(U.amt, ptr.amt);
      gl.uniform1f(U.mode, p.mode);
      gl.uniform1f(U.grain, p.grain);
      gl.uniform1f(U.strength, p.strength);
      gl.uniform1f(U.fade, p.fade);
      gl.uniform3fv(U.brand, rgb(p.brand));
      gl.uniform3fv(U.accent, rgb(p.accent));
      gl.uniform3fv(U.base, rgb(p.base));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const loop = (now: number) => {
      draw(now);
      if (!disposed && !reduce && visible && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    redraw.current = () => draw(performance.now());

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
    });
    io.observe(el);
    const ro = new ResizeObserver(() => draw(performance.now()));
    ro.observe(el);
    const onVisibility = () => !document.hidden && start();
    document.addEventListener('visibilitychange', onVisibility);
    const surface = el.parentElement ?? el;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ptr.x = (e.clientX - r.left) / r.width;
      ptr.y = 1 - (e.clientY - r.top) / r.height;
      ptr.amt = Math.min(1, ptr.amt + 0.3);
    };
    surface.addEventListener('pointermove', onMove);
    const onLost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
    };
    el.addEventListener('webglcontextlost', onLost);
    start();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      surface.removeEventListener('pointermove', onMove);
      el.removeEventListener('webglcontextlost', onLost);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      // No loseContext(): under React StrictMode the same canvas mounts twice and must stay usable.
      redraw.current = () => {};
    };
  }, [props.src]);

  // Recolor instantly even when the loop is paused (reduced motion, offscreen).
  useEffect(() => redraw.current(), [props.brand, props.accent, props.base, props.mode, props.strength]);

  if (!props.src) return <div className={`hero-fallback ${props.className ?? ''}`} aria-hidden />;
  if (failed) return <img className={`hero-img ${props.className ?? ''}`} src={props.src} alt={props.alt} />;
  return <canvas ref={canvas} className={`hero-canvas ${props.className ?? ''}`} role="img" aria-label={props.alt} />;
}
