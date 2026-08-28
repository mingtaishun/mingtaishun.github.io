/*
 * Danny Flip standalone Three.js reader.
 *
 * The runtime consumes build-generated JPEG page URLs and normalized QR-link
 * coordinates. It performs no PDF parsing or QR detection in the browser.
 */
(function () {
  'use strict';

  const MOBILE_SHORT_EDGE = 600;
  const MOBILE_COARSE_EDGE = 1024;
  const READER_CONTROLS_EDGE = 58;
  const PAGE_ASPECT_ESTIMATE = 1 / Math.SQRT2;
  const MOBILE_RENDER_PIXEL_RATIO = 2;
  const MOBILE_TEXTURE_MAXIMUM_EDGE = 1600;
  const LOW_MEMORY_TEXTURE_MAXIMUM_EDGE = 832;
  const HANDHELD_DRAG_THRESHOLD = 15;
  const POINTER_DRAG_THRESHOLD = 20;
  const DRAG_COMMIT_PROGRESS = 0.22;
  const DRAG_FLICK_VELOCITY = 0.45;
  const ZOOM_MINIMUM = 1;
  const ZOOM_MAXIMUM = 3;
  const ZOOM_STEP = 0.5;
  const TEXTURE_FALLBACK_SESSION_KEY = 'danny-flip:texture-fallback:runtime-v1';
  const NETWORK_RETRY_DELAYS = [1000, 3000, 10000];
  const SEARCH_PARAMS = new URLSearchParams(window.location.search);
  const PERF_ENABLED = SEARCH_PARAMS.has('perf');
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const READER_CONFIG = window.DANNY_FLIP_READER_CONFIG || {};
  const CONFIG = Object.freeze({
    textureCacheSize: clamp(
      Number(SEARCH_PARAMS.get('textures') || READER_CONFIG.textureCacheSize || 12),
      6,
      24,
    ),
    pageSegments: 20,
    stackCount: 30,
    stiffness: 3,
    flipDuration: clamp(
      Number(SEARCH_PARAMS.get('duration') || READER_CONFIG.flipDuration || 650),
      360,
      1100,
    ),
    renderPixelRatio: clamp(
      Number(SEARCH_PARAMS.get('dpr') || READER_CONFIG.renderPixelRatio || 2),
      1,
      2,
    ),
    textureMaximumEdge: clamp(
      Number(SEARCH_PARAMS.get('textureEdge') || READER_CONFIG.textureMaximumEdge || 1600),
      832,
      1600,
    ),
    textureMode: (
      SEARCH_PARAMS.get('textureMode') || READER_CONFIG.textureMode
    ) === 'lru' ? 'lru' : 'auto',
    testGpuFailAfter: PERF_ENABLED
      ? clamp(Number(SEARCH_PARAMS.get('gpuFailAfter') || 0), 0, 1000)
      : 0,
    testNetworkFailPage: PERF_ENABLED
      ? clamp(Number(SEARCH_PARAMS.get('networkFailPage') || 0), 0, 1000)
      : 0,
    testContextLossAfter: PERF_ENABLED
      ? clamp(Number(SEARCH_PARAMS.get('contextLossAfter') || 0), 0, 60000)
      : 0,
    pageLinkDelay: clamp(
      finiteNumber(
        SEARCH_PARAMS.get('linkDelay') ?? READER_CONFIG.pageLinkDelay,
        1000,
      ),
      0,
      10000,
    ),
    pageMode: enumValue(
      SEARCH_PARAMS.get('pageMode') || READER_CONFIG.pageMode,
      ['single', 'double'],
      'double',
    ),
    orientation: enumValue(
      SEARCH_PARAMS.get('orientation') || READER_CONFIG.orientation,
      ['auto', 'portrait', 'landscape'],
      'auto',
    ),
    portraitRotation: enumValue(
      SEARCH_PARAMS.get('portraitRotation') || READER_CONFIG.portraitRotation,
      ['auto', 'always', 'never'],
      'auto',
    ),
    initialPage: clamp(
      finiteNumber(SEARCH_PARAMS.get('initialPage') ?? READER_CONFIG.initialPage, 1),
      1,
      100000,
    ),
  });
  const PAGE_URLS = Array.from(window.DANNY_FLIP_PAGE_IMAGES || []);
  const PAGE_LINKS = Array.from(window.DANNY_FLIP_PAGE_LINKS || []).filter(function (link) {
    return Number.isInteger(link?.page)
      && Number.isFinite(link?.x)
      && link.x >= 0
      && link.x <= 1
      && Number.isFinite(link?.y)
      && link.y >= 0
      && link.y <= 1
      && typeof link?.url === 'string'
      && /^https?:\/\//i.test(link.url);
  });
  const state = {
    book: null,
    layout: '',
    pageMode: CONFIG.pageMode,
    resizeTimer: 0,
    stressTimer: 0,
  };

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function enumValue(value, allowed, fallback) {
    const normalized = String(value || '').toLowerCase();
    return allowed.includes(normalized) ? normalized : fallback;
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function easeInOutCubic(value) {
    return value < 0.5
      ? 4 * value * value * value
      : 1 - Math.pow(-2 * value + 2, 3) / 2;
  }

  function viewportSize() {
    const viewport = window.visualViewport;
    return {
      width: Math.round(viewport?.width || window.innerWidth),
      height: Math.round(viewport?.height || window.innerHeight),
    };
  }

  function deviceProfile() {
    const viewport = viewportSize();
    const shortEdge = Math.min(viewport.width, viewport.height);
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    return {
      ...viewport,
      handheld: shortEdge <= MOBILE_SHORT_EDGE || (coarse && shortEdge <= MOBILE_COARSE_EDGE),
      portrait: viewport.height > viewport.width,
      dpr: window.devicePixelRatio || 1,
    };
  }

  function isLowMemoryDevice() {
    const memory = Number(navigator.deviceMemory);
    return Number.isFinite(memory) && memory > 0 && memory <= 4;
  }

  function desiredLayout() {
    const profile = deviceProfile();
    if (CONFIG.orientation === 'landscape') return 'landscape';
    const portrait = CONFIG.orientation === 'portrait' || profile.portrait;
    const portraitLayout = CONFIG.orientation === 'portrait' || profile.handheld;
    if (!portraitLayout || !portrait) return 'landscape';
    if (state.pageMode === 'single' || CONFIG.portraitRotation === 'never') {
      return 'portrait-single';
    }
    if (CONFIG.portraitRotation === 'always') return 'portrait-rotated';

    // Compare the complete two-page area after a 90-degree rotation. A side
    // toolbar consumes scarce screen width; the floating dock needs enough
    // clearance above or below the book. Pick the larger fully visible book.
    const rotatedSpreadHeight = PAGE_ASPECT_ESTIMATE * 2;
    const sideScale = Math.min(
      Math.max(1, profile.width - READER_CONTROLS_EDGE),
      profile.height / rotatedSpreadHeight,
    );
    const dockScale = Math.min(
      profile.width,
      profile.height / rotatedSpreadHeight,
    );
    const sideArea = rotatedSpreadHeight * sideScale * sideScale;
    const dockArea = rotatedSpreadHeight * dockScale * dockScale;
    const dockClearance = profile.height - rotatedSpreadHeight * dockScale;
    const dockFitsBesideBook = dockClearance >= READER_CONTROLS_EDGE + 24;
    return dockFitsBesideBook && dockArea >= sideArea
      ? 'portrait-stage-rotated'
      : 'portrait-rotated';
  }

  function startIntroAnimation() {
    const intro = document.getElementById('reader-intro');
    const canvas = document.getElementById('reader-intro-canvas');
    if (!intro || !canvas) return;

    const profile = deviceProfile();
    const constrained = profile.handheld || isLowMemoryDevice();
    const duration = REDUCED_MOTION ? 520 : 2300;
    const pixelRatio = clamp(profile.dpr, 0.75, constrained ? 0.85 : 1.15);
    canvas.width = Math.max(1, Math.round(profile.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(profile.height * pixelRatio));

    function fadeOut(delay) {
      window.setTimeout(function () {
        intro.classList.add('is-ending');
        window.setTimeout(function () { intro.remove(); }, 280);
      }, delay);
    }

    if (REDUCED_MOTION) {
      fadeOut(duration);
      return;
    }

    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: constrained ? 'low-power' : 'high-performance',
    });
    if (!gl) {
      fadeOut(720);
      return;
    }

    const vertexSource = `
      attribute vec2 aPosition;
      void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
    `;
    const fragmentSource = `
      precision mediump float;
      uniform vec2 uResolution;
      uniform float uProgress;
      uniform float uTime;

      float hash21(vec2 value) {
        value = fract(value * vec2(123.34, 456.21));
        value += dot(value, value + 45.32);
        return fract(value.x * value.y);
      }

      float valueNoise(vec2 point) {
        vec2 cell = floor(point);
        vec2 local = fract(point);
        local = local * local * (3.0 - 2.0 * local);
        float a = hash21(cell);
        float b = hash21(cell + vec2(1.0, 0.0));
        float c = hash21(cell + vec2(0.0, 1.0));
        float d = hash21(cell + vec2(1.0, 1.0));
        return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
      }

      float fbm(vec2 point) {
        float value = 0.0;
        float amplitude = 0.5;
        mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
        for (int octave = 0; octave < 4; octave++) {
          value += valueNoise(point) * amplitude;
          point = turn * point * 2.03 + 17.17;
          amplitude *= 0.5;
        }
        return value;
      }

      void main() {
        vec2 centered = gl_FragCoord.xy / uResolution - 0.5;
        float aspect = uResolution.x / uResolution.y;
        centered.x *= aspect;
        float radius = length(centered);
        float maximumRadius = length(vec2(aspect, 1.0)) * 0.5;
        float front = mix(-0.15, maximumRadius + 0.18, uProgress);
        vec2 flow = vec2(uTime * 0.055, -uTime * 0.037);
        float broadNoise = (fbm(centered * 5.2 + flow) - 0.5) * 0.115;
        float detailNoise = (valueNoise(centered * 19.0 - flow * 1.7) - 0.5) * 0.048;
        float grain = (hash21(floor(gl_FragCoord.xy * 0.62)) - 0.5) * 0.026;
        float field = radius + broadNoise + detailNoise + grain;
        float whiteCover = smoothstep(front - 0.022, front + 0.052, field);
        float edgeBand = 1.0 - smoothstep(0.014, 0.085, abs(field - front));
        float dustNoise = hash21(floor(gl_FragCoord.xy * 0.44) + floor(uTime * 16.0));
        whiteCover = max(whiteCover, step(0.955, dustNoise) * edgeBand * 0.82);
        // The WebGL canvas is composited as premultiplied alpha. Keep RGB at
        // or below alpha so iOS/WKWebView does not add unclamped white into
        // the colorful page background during the dissolve.
        gl_FragColor = vec4(vec3(whiteCover), whiteCover);
      }
    `;

    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    const vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertexShader || !fragmentShader) {
      fadeOut(0);
      return;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      fadeOut(0);
      return;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const resolutionUniform = gl.getUniformLocation(program, 'uResolution');
    const progressUniform = gl.getUniformLocation(program, 'uProgress');
    const timeUniform = gl.getUniformLocation(program, 'uTime');
    gl.uniform2f(resolutionUniform, canvas.width, canvas.height);
    gl.viewport(0, 0, canvas.width, canvas.height);
    intro.style.background = 'transparent';

    const startedAt = performance.now();
    let frame = 0;
    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      window.cancelAnimationFrame(frame);
      intro.classList.add('is-ending');
      window.setTimeout(function () {
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        intro.remove();
      }, 280);
    }

    function draw(now) {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / duration);
      gl.uniform1f(progressUniform, 1 - Math.pow(1 - progress, 2.25));
      gl.uniform1f(timeUniform, elapsed / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (progress < 1) frame = window.requestAnimationFrame(draw);
      else finish();
    }

    frame = window.requestAnimationFrame(draw);
  }

  class TextureCache {
    constructor(renderer, pageUrls, maximumSize, protectedPages, maximumTextureEdge, options) {
      this.renderer = renderer;
      this.pageUrls = pageUrls;
      this.maximumSize = maximumSize;
      this.protectedPages = protectedPages;
      this.maximumTextureEdge = maximumTextureEdge;
      this.mode = options.mode;
      this.onGpuFailure = options.onGpuFailure;
      this.onTextureReady = options.onTextureReady;
      this.testGpuFailAfter = options.testGpuFailAfter;
      this.testNetworkFailPage = options.testNetworkFailPage;
      this.entries = new Map();
      this.retryCounts = new Map();
      this.retryTimers = new Map();
      this.networkFailedPages = new Set();
      this.uploadedTextures = 0;
      this.networkFailures = 0;
      this.loadQueue = [];
      this.activeLoads = 0;
      this.queueClock = 0;
      this.clock = 0;
    }

    has(page) {
      return Boolean(this.entries.get(page)?.texture);
    }

    get(page) {
      const entry = this.entries.get(page);
      if (!entry?.texture) return null;
      entry.usedAt = ++this.clock;
      return entry.texture;
    }

    load(page, priority, options) {
      if (page < 1 || page > this.pageUrls.length) return Promise.resolve(null);
      const existing = this.entries.get(page);
      if (existing?.texture) {
        existing.usedAt = ++this.clock;
        return Promise.resolve(existing.texture);
      }
      if (existing?.promise) return existing.promise;

      if (
        priority
        && (this.retryCounts.get(page) || 0) >= NETWORK_RETRY_DELAYS.length
        && !this.retryTimers.has(page)
      ) {
        this.retryCounts.delete(page);
      }

      const startedAt = performance.now();
      const entry = { promise: null, texture: null, usedAt: ++this.clock };
      const promise = new Promise((resolve, reject) => {
        const startLoad = () => {
          const image = new Image();
          let texture = null;
          image.decoding = 'async';
          if ('fetchPriority' in image) image.fetchPriority = priority ? 'high' : 'auto';
          image.onload = () => {
            try {
              const sourceEdge = Math.max(image.naturalWidth, image.naturalHeight);
              const scale = Math.min(1, this.maximumTextureEdge / Math.max(1, sourceEdge));
              let source = image;
              if (scale < 1) {
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                const context = canvas.getContext('2d', { alpha: false });
                context.fillStyle = '#fff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.imageSmoothingEnabled = true;
                context.imageSmoothingQuality = 'high';
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                source = canvas;
              }
              texture = new THREE.Texture(source);
              texture.pageAspect = image.naturalWidth / Math.max(1, image.naturalHeight);
              texture.name = `page-${page}`;
              texture.generateMipmaps = false;
              texture.minFilter = THREE.LinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.wrapS = THREE.ClampToEdgeWrapping;
              texture.wrapT = THREE.ClampToEdgeWrapping;
              texture.needsUpdate = true;
              this.uploadTexture(texture, page);
              entry.texture = texture;
              entry.promise = null;
              entry.usedAt = ++this.clock;
              this.retryCounts.delete(page);
              this.networkFailedPages.delete(page);
              this.prune();
              this.onTextureReady(page, texture);
              if (this.mode !== 'lru' && !options?.retainSource) {
                this.releaseSource(page);
              }
              if (PERF_ENABLED) {
                const stats = this.stats();
                console.info('[reader:texture]', JSON.stringify({
                  page,
                  width: source.width,
                  height: source.height,
                  durationMs: Math.round(performance.now() - startedAt),
                  residentTextures: stats.residentTextures,
                  cacheLimit: this.mode === 'lru' ? this.maximumSize : 'all',
                  mode: this.mode,
                }));
              }
              resolve(texture);
            } catch (error) {
              texture?.dispose();
              this.entries.delete(page);
              if (error.gpuFailure) {
                this.onGpuFailure(error);
              } else {
                this.handleNetworkFailure(page, error);
              }
              reject(error);
            } finally {
              image.onload = null;
              image.onerror = null;
              this.finishLoadTask();
            }
          };
          image.onerror = () => {
            const error = new Error(`JPEG for page ${page} failed to load`);
            image.onload = null;
            image.onerror = null;
            this.entries.delete(page);
            this.handleNetworkFailure(page, error);
            reject(error);
            this.finishLoadTask();
          };
          image.src = this.testNetworkFailPage === page
            ? `./__reader-network-failure__/page-${String(page).padStart(3, '0')}.jpg`
            : this.pageUrls[page - 1];
        };
        this.loadQueue.push({
          priority: priority ? 1 : 0,
          order: ++this.queueClock,
          start: startLoad,
        });
        this.loadQueue.sort((a, b) => b.priority - a.priority || a.order - b.order);
        this.pumpLoadQueue();
      }).catch((error) => {
        this.entries.delete(page);
        throw error;
      });
      entry.promise = promise;
      this.entries.set(page, entry);
      return promise;
    }

    pumpLoadQueue() {
      while (this.activeLoads < 2 && this.loadQueue.length) {
        const task = this.loadQueue.shift();
        this.activeLoads += 1;
        task.start();
      }
    }

    finishLoadTask() {
      this.activeLoads = Math.max(0, this.activeLoads - 1);
      this.pumpLoadQueue();
    }

    uploadTexture(texture, page) {
      if (typeof this.renderer.setTexture2D !== 'function') return;
      const gl = this.renderer.getContext();
      if (!gl || gl.isContextLost()) {
        const error = new Error(`WebGL context is unavailable for page ${page}`);
        error.gpuFailure = true;
        error.gpuReason = 'context-lost';
        error.contextLost = true;
        throw error;
      }
      for (let index = 0; index < 8 && gl.getError() !== gl.NO_ERROR; index += 1) {
        // Clear errors left by prior draw calls so this upload owns the result.
      }
      if (
        this.mode !== 'lru'
        && this.testGpuFailAfter
        && this.uploadedTextures >= this.testGpuFailAfter
      ) {
        const error = new Error(`Simulated GPU texture upload ${this.uploadedTextures + 1} failure`);
        error.gpuFailure = true;
        error.gpuReason = 'simulated-upload-failure';
        throw error;
      }
      try {
        this.renderer.setTexture2D(texture, 0);
      } catch (cause) {
        const error = new Error(`GPU texture upload failed for page ${page}`);
        error.cause = cause;
        error.gpuFailure = true;
        error.gpuReason = 'upload-exception';
        throw error;
      }
      if (gl.isContextLost()) {
        const error = new Error(`WebGL context was lost while uploading page ${page}`);
        error.gpuFailure = true;
        error.gpuReason = 'context-lost';
        error.contextLost = true;
        throw error;
      }
      const glError = gl.getError();
      if (glError !== gl.NO_ERROR) {
        const error = new Error(`GPU upload for page ${page} returned WebGL ${glError}`);
        error.gpuFailure = true;
        error.gpuReason = glError === gl.OUT_OF_MEMORY ? 'out-of-memory' : 'webgl-error';
        throw error;
      }
      this.uploadedTextures += 1;
    }

    handleNetworkFailure(page, error) {
      this.networkFailures += 1;
      this.networkFailedPages.add(page);
      const retryIndex = this.retryCounts.get(page) || 0;
      if (PERF_ENABLED) {
        console.warn('[reader:texture-network]', JSON.stringify({
          page,
          attempt: retryIndex + 1,
          message: error.message,
        }));
      }
      if (retryIndex >= NETWORK_RETRY_DELAYS.length || this.retryTimers.has(page)) return;
      this.retryCounts.set(page, retryIndex + 1);
      const timer = window.setTimeout(() => {
        this.retryTimers.delete(page);
        this.load(page, false).catch(function () {});
      }, NETWORK_RETRY_DELAYS[retryIndex]);
      this.retryTimers.set(page, timer);
    }

    releaseSource(page) {
      const texture = this.entries.get(page)?.texture;
      if (!texture?.image) return;
      if (typeof texture.image.close === 'function') texture.image.close();
      texture.image = null;
    }

    enableLru() {
      this.mode = 'lru';
      this.prune();
    }

    stats() {
      const residentTextures = Array.from(this.entries.values()).filter(
        (entry) => Boolean(entry.texture),
      ).length;
      return {
        mode: this.mode,
        uploaded: residentTextures,
        totalUploads: this.uploadedTextures,
        total: this.pageUrls.length,
        residentTextures,
        networkFailures: this.networkFailures,
        networkFailedPages: Array.from(this.networkFailedPages).sort((a, b) => a - b),
        cacheLimit: this.mode === 'lru' ? this.maximumSize : this.pageUrls.length,
      };
    }

    prune() {
      if (this.mode !== 'lru') return;
      const protectedSet = new Set(this.protectedPages());
      const readyEntries = Array.from(this.entries.entries()).filter(function ([, entry]) {
        return Boolean(entry.texture);
      });
      if (readyEntries.length <= this.maximumSize) return;
      readyEntries.sort(function (a, b) { return a[1].usedAt - b[1].usedAt; });
      let readyCount = readyEntries.length;
      const evictedPages = [];
      for (const [page, entry] of readyEntries) {
        if (readyCount <= this.maximumSize) break;
        if (protectedSet.has(page)) continue;
        entry.texture.dispose();
        this.entries.delete(page);
        evictedPages.push(page);
        readyCount -= 1;
      }
      if (PERF_ENABLED && evictedPages.length) {
        console.info('[reader:cache]', JSON.stringify({
          mode: 'lru',
          limit: this.maximumSize,
          residentTextures: readyCount,
          evictedPages,
        }));
      }
    }

    dispose() {
      this.retryTimers.forEach(function (timer) { window.clearTimeout(timer); });
      this.retryTimers.clear();
      this.entries.forEach(function (entry) { entry.texture?.dispose(); });
      this.entries.clear();
    }
  }

  class DannyFlipPaper extends THREE.Mesh {
    constructor(options) {
      const materialOptions = {
        color: 0xffffff,
        shading: THREE.SmoothShading,
        shininess: 15,
      };
      const sideMaterial = new THREE.MeshPhongMaterial(materialOptions);
      const frontMaterial = new THREE.MeshPhongMaterial(materialOptions);
      const backMaterial = new THREE.MeshPhongMaterial(materialOptions);
      frontMaterial.transparent = true;
      backMaterial.transparent = true;
      const materials = [
        sideMaterial,
        sideMaterial,
        sideMaterial,
        sideMaterial,
        frontMaterial,
        backMaterial,
      ];
      const geometry = new THREE.BoxGeometry(
        options.width,
        options.height,
        options.depth,
        options.segments,
        1,
        1,
      );
      super(geometry, new THREE.MeshFaceMaterial(materials));
      this.width = options.width;
      this.height = options.height;
      this.depth = options.depth;
      this.segments = options.segments;
      this.angles = [0, 180, 0, 0, 180, 0];
      this.stiffness = 0;
      this.newStiffness = 0;
      this.oldDepth = options.depth;
      this.sheetIndex = -1;
      this.isFlipping = false;
      this.skipFlip = false;
      this.isEdge = false;
      this.castShadow = options.castShadow;
      this.receiveShadow = true;
      this.frustumCulled = false;
      this.placeholderTexture = options.placeholderTexture;
      this.setTextures(options.placeholderTexture, options.placeholderTexture);
      this.updateAngle();
    }

    setMaterialTexture(material, texture) {
      material.map = texture || this.placeholderTexture;
      material.needsUpdate = true;
    }

    setTextures(front, back) {
      this.setMaterialTexture(this.material.materials[4], front);
      this.setMaterialTexture(this.material.materials[5], back);
    }

    setFrontTexture(texture) {
      this.setMaterialTexture(this.material.materials[4], texture);
    }

    setBackTexture(texture) {
      this.setMaterialTexture(this.material.materials[5], texture);
    }

    updateAngle() {
      // Exact folds === 1 path from MOCKUP.FlexBoxPaper.updateAngle.
      const width = this.width
        * (1 - Math.sin(this.stiffness / 2 * (this.stiffness / 2)) / 2)
        - this.width * this.stiffness / 20;
      const segmentCount = this.segments;
      const bendLength = width;
      const bendStrength = bendLength * this.stiffness;
      const angle = this.angles[1] * Math.PI / 180;
      const secondaryAngle = this.angles[4] * Math.PI / 180;
      const depthAngle = (this.angles[1] - 90) * Math.PI / 180;
      const frontControl = [];
      const backControl = [];

      frontControl[0] = new THREE.Vector3(
        -bendLength * Math.cos(angle), 0, Math.sin(angle) * bendLength,
      );
      frontControl[1] = new THREE.Vector3(
        -bendLength / 2 * Math.cos(secondaryAngle),
        0,
        bendLength / 2 * Math.sin(secondaryAngle),
      );
      const shoulderAngle = (45 + this.angles[1] / 2) * Math.PI / 180;
      frontControl[2] = new THREE.Vector3(
        -Math.cos(shoulderAngle) * bendStrength / 2,
        0,
        Math.sin(shoulderAngle) * bendStrength / 2,
      );
      frontControl[3] = new THREE.Vector3(0, 0, 0);

      backControl[3] = new THREE.Vector3(
        frontControl[0].x - Math.cos(depthAngle) * this.depth,
        0,
        frontControl[0].z + Math.sin(depthAngle) * this.depth,
      );
      backControl[2] = new THREE.Vector3(
        frontControl[1].x - Math.cos(depthAngle) * this.depth,
        0,
        frontControl[1].z + Math.sin(depthAngle) * this.depth,
      );
      backControl[1] = new THREE.Vector3(
        frontControl[2].x - Math.cos(depthAngle) * this.depth,
        0,
        frontControl[2].z + Math.sin(depthAngle) * this.depth,
      );
      backControl[0] = new THREE.Vector3(
        frontControl[3].x - Math.cos(depthAngle) * this.depth,
        0,
        frontControl[3].z + Math.sin(depthAngle) * this.depth,
      );

      const frontCurve = new THREE.CubicBezierCurve3(...frontControl);
      const backCurve = new THREE.CubicBezierCurve3(...backControl);
      const frontPoints = frontCurve.getPoints(segmentCount);
      const backPoints = backCurve.getPoints(segmentCount);
      const cumulativeLengths = [0];
      let totalLength = 0;
      for (let index = 1; index < frontPoints.length; index += 1) {
        totalLength += frontPoints[index].distanceTo(frontPoints[index - 1]);
        cumulativeLengths.push(totalLength);
      }

      const geometry = this.geometry;
      const rowSize = segmentCount + 1;
      const finalVertex = geometry.vertices.length;
      const cornerOffset = 7;
      let cursor = 8;
      const setXZ = (vertexIndex, point) => {
        geometry.vertices[vertexIndex].x = point.x;
        geometry.vertices[vertexIndex].z = point.z;
      };

      [0, 2, cursor + rowSize * 2 - 1, cursor + rowSize * 3 - 1,
        cursor + rowSize * 5 - 1, cursor + rowSize * 6 - 1]
        .forEach((vertex) => setXZ(vertex, frontPoints[segmentCount]));
      [1, 3, cursor + rowSize - 1, cursor + rowSize * 4 - 1,
        cursor + rowSize * 6, cursor + rowSize * 7]
        .forEach((vertex) => setXZ(vertex, backPoints[0]));
      [5, 7, cursor + rowSize, cursor + rowSize * 2,
        cursor + rowSize * 4, cursor + rowSize * 5]
        .forEach((vertex) => setXZ(vertex, frontPoints[0]));
      [4, 6, cursor, cursor + rowSize * 3,
        cursor + rowSize * 7 - 1, cursor + rowSize * 8 - 1]
        .forEach((vertex) => setXZ(vertex, backPoints[segmentCount]));

      cursor += 1;
      for (let segment = 0; segment < segmentCount - 1; segment += 1) {
        const backPoint = backPoints[segmentCount - 1 - segment];
        const frontPoint = frontPoints[segment + 1];
        [cursor, cursor + rowSize * 3,
          finalVertex - cursor + cornerOffset - rowSize,
          finalVertex - cursor + cornerOffset]
          .forEach((vertex) => setXZ(vertex, backPoint));
        [cursor + rowSize, cursor + rowSize * 2,
          cursor + rowSize * 4, cursor + rowSize * 5]
          .forEach((vertex) => setXZ(vertex, frontPoint));
        cursor += 1;
      }

      const uvs = geometry.faceVertexUvs[0];
      const faces = geometry.faces;
      let lengthIndex = 0;
      for (let faceIndex = 0; faceIndex < uvs.length; faceIndex += 1) {
        if (faces[faceIndex].materialIndex === 4) {
          const u = cumulativeLengths[lengthIndex] / totalLength;
          if (faceIndex % 2 === 0) {
            uvs[faceIndex][0].x = u;
            uvs[faceIndex][1].x = u;
            uvs[faceIndex + 1][0].x = u;
            lengthIndex += 1;
          } else {
            uvs[faceIndex - 1][2].x = u;
            uvs[faceIndex][1].x = u;
            uvs[faceIndex][2].x = u;
          }
        } else if (faces[faceIndex].materialIndex === 5) {
          const u = 1 - cumulativeLengths[lengthIndex] / totalLength;
          if (faceIndex % 2 === 0) {
            uvs[faceIndex][0].x = u;
            uvs[faceIndex][1].x = u;
            uvs[faceIndex + 1][0].x = u;
            lengthIndex -= 1;
          } else {
            uvs[faceIndex - 1][2].x = u;
            uvs[faceIndex][1].x = u;
            uvs[faceIndex][2].x = u;
          }
        }
      }

      this.scale.x = this.scale.z = bendLength / totalLength;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geometry.verticesNeedUpdate = true;
      geometry.computeFaceNormals();
      geometry.computeVertexNormals();
      geometry.uvsNeedUpdate = true;
      geometry.normalsNeedUpdate = true;
    }

    dispose() {
      new Set(this.material.materials).forEach((material) => material.dispose());
      this.geometry.dispose();
    }
  }

  class PageLinkOverlay {
    constructor(book, container, links, delay) {
      this.book = book;
      this.container = container;
      this.links = links;
      this.delay = delay;
      this.timer = 0;
      this.signature = '';
    }

    visiblePages() {
      if (this.book.pageMode === 'single') return [this.book.activePage];
      return this.book.visiblePagesForSpread(this.book.spread);
    }

    isStable() {
      return Boolean(
        this.book.bookGroup
        && !this.book.pointer
        && !this.book.dragState
        && !this.book.activeAnimations
        && !this.book.pendingNavigation,
      );
    }

    currentSignature() {
      return `${this.book.pageMode}:${this.book.spread}:${this.book.activePage}`;
    }

    clear() {
      window.clearTimeout(this.timer);
      this.timer = 0;
      this.container?.replaceChildren();
    }

    interrupt() {
      this.clear();
      this.signature = '';
    }

    sync() {
      if (!this.container || !this.links.length) return;
      if (!this.isStable()) {
        this.interrupt();
        return;
      }

      const signature = this.currentSignature();
      if (signature === this.signature) {
        this.positionLinks();
        return;
      }

      this.clear();
      this.signature = signature;
      const visiblePages = new Set(this.visiblePages());
      if (!this.links.some((link) => visiblePages.has(link.page))) return;
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        if (!this.isStable() || this.currentSignature() !== signature) return;
        this.renderLinks(visiblePages);
      }, this.delay);
    }

    renderLinks(visiblePages) {
      const fragment = document.createDocumentFragment();
      this.links.forEach((link) => {
        if (!visiblePages.has(link.page)) return;
        const anchor = document.createElement('a');
        anchor.className = 'reader-page-link';
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.dataset.page = String(link.page);
        anchor.dataset.x = String(link.x);
        anchor.dataset.y = String(link.y);
        anchor.setAttribute('aria-label', `Open QR link on page ${link.page}`);
        anchor.title = 'Open link';
        anchor.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
          + '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path>'
          + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>'
          + '</svg>';
        fragment.appendChild(anchor);
      });
      this.container.replaceChildren(fragment);
      this.positionLinks();
    }

    positionLinks() {
      if (!this.container?.childElementCount || !this.book.bookGroup) return;
      this.book.scene.updateMatrixWorld(true);
      this.book.camera.updateMatrixWorld(true);
      const canvasWidth = Math.max(1, this.book.canvas.clientWidth);
      const canvasHeight = Math.max(1, this.book.canvas.clientHeight);
      const canvasTop = this.book.canvas.offsetTop - canvasHeight / 2;
      const canvasLeft = this.book.canvas.offsetLeft;

      this.container.querySelectorAll('.reader-page-link').forEach((anchor) => {
        const page = Number(anchor.dataset.page);
        const normalizedX = Number(anchor.dataset.x);
        const normalizedY = Number(anchor.dataset.y);
        const sheetIndex = page % 2 === 0 ? page / 2 - 1 : (page - 1) / 2;
        const paper = this.book.paperForSheet(sheetIndex);
        if (!paper) {
          anchor.hidden = true;
          return;
        }
        const point = new THREE.Vector3(
          page % 2 === 0
            ? (normalizedX - 1) * this.book.PW
            : normalizedX * this.book.PW,
          (0.5 - normalizedY) * this.book.PH,
          page % 2 === 0 ? paper.depth / 2 : -paper.depth / 2,
        );
        paper.localToWorld(point);
        point.project(this.book.camera);
        const inView = point.z >= -1 && point.z <= 1
          && point.x >= -1.05 && point.x <= 1.05
          && point.y >= -1.05 && point.y <= 1.05;
        anchor.hidden = !inView;
        if (!inView) return;
        anchor.style.left = `${canvasLeft + (point.x + 1) * canvasWidth / 2}px`;
        anchor.style.top = `${canvasTop + (1 - point.y) * canvasHeight / 2}px`;
      });
    }

    dispose() {
      this.interrupt();
    }
  }

  class DannyFlipBook {
    constructor(canvas, pageUrls) {
      this.canvas = canvas;
      this.pageUrls = pageUrls;
      this.totalPages = pageUrls.length;
      this.maxSpread = Math.ceil(Math.max(0, this.totalPages - 1) / 2);
      this.spread = 0;
      this.activePage = 1;
      this.pageMode = state.pageMode;
      this.zoomScale = ZOOM_MINIMUM;
      this.panX = 0;
      this.panY = 0;
      this.modelScale = 1;
      this.viewWidth = 1;
      this.viewHeight = 1;
      this.oldBaseNumber = 0;
      this.stackCount = CONFIG.stackCount;
      this.stiffness = CONFIG.stiffness;
      this.duration = CONFIG.flipDuration;
      this.activeAnimations = 0;
      this.centerAnimationToken = 0;
      this.animationPages = new Map();
      this.bufferingLoads = 0;
      this.pendingNavigation = null;
      this.renderFrame = 0;
      this.prefetchAbortController = null;
      this.prefetchPromise = null;
      this.residentPreloadPromise = null;
      this.residentLoaderCancelled = false;
      this.contextReloadScheduled = false;
      this.contextLossTimer = 0;
      this.profile = deviceProfile();
      this.lowMemory = isLowMemoryDevice();
      this.constrained = this.profile.handheld || this.lowMemory;
      this.renderPixelRatio = this.lowMemory
        ? 1
        : this.profile.handheld
          ? Math.min(this.profile.dpr, MOBILE_RENDER_PIXEL_RATIO)
          : Math.min(this.profile.dpr, CONFIG.renderPixelRatio);
      this.textureMaximumEdge = this.lowMemory
        ? LOW_MEMORY_TEXTURE_MAXIMUM_EDGE
        : this.profile.handheld
          ? MOBILE_TEXTURE_MAXIMUM_EDGE
          : CONFIG.textureMaximumEdge;
      let sessionFallback = false;
      try {
        sessionFallback = sessionStorage.getItem(TEXTURE_FALLBACK_SESSION_KEY) === 'lru';
      } catch (error) {
        if (PERF_ENABLED) console.warn('[reader:texture-session]', error);
      }
      this.textureMode = CONFIG.textureMode === 'lru' || sessionFallback
        ? 'lru'
        : 'resident-loading';
      this.startedInLru = this.textureMode === 'lru';
      this.pointer = null;
      this.dragState = null;
      this.pages = [];
      this.handleContextLost = (event) => {
        event.preventDefault();
        const error = new Error('WebGL context lost');
        error.gpuFailure = true;
        error.gpuReason = 'context-lost';
        error.contextLost = true;
        this.fallbackToLru(error);
      };
      this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
      this.pageLinks = new PageLinkOverlay(
        this,
        document.getElementById('reader-page-links'),
        PAGE_LINKS,
        CONFIG.pageLinkDelay,
      );
      this.createRenderer();
      this.cache = new TextureCache(
        this.renderer,
        pageUrls,
        CONFIG.textureCacheSize,
        () => this.protectedPages(),
        this.textureMaximumEdge,
        {
          mode: this.textureMode,
          onGpuFailure: (error) => this.fallbackToLru(error),
          onTextureReady: (page) => this.handleTextureReady(page),
          testGpuFailAfter: CONFIG.testGpuFailAfter,
          testNetworkFailPage: CONFIG.testNetworkFailPage,
        },
      );
      this.bindPointerInput();
      this.logTextureMode('startup');
    }

    get textureStats() {
      return this.cache?.stats() || {
        mode: this.textureMode,
        uploaded: 0,
        total: this.totalPages,
        residentTextures: 0,
        networkFailures: 0,
      };
    }

    logTextureMode(reason) {
      if (!PERF_ENABLED) return;
      console.info('[reader:texture-mode]', JSON.stringify({
        mode: this.textureMode,
        reason,
        ...this.textureStats,
      }));
    }

    rememberLruFallback() {
      try {
        sessionStorage.setItem(TEXTURE_FALLBACK_SESSION_KEY, 'lru');
      } catch (error) {
        if (PERF_ENABLED) console.warn('[reader:texture-session]', error);
      }
    }

    fallbackToLru(error) {
      if (this.textureMode === 'lru') {
        if (error.contextLost && !this.startedInLru && !this.contextReloadScheduled) {
          this.contextReloadScheduled = true;
          window.setTimeout(function () { window.location.reload(); }, 80);
        } else if (error.contextLost && !this.contextReloadScheduled) {
          showReaderError(error);
        }
        return;
      }
      this.rememberLruFallback();
      this.residentLoaderCancelled = true;
      this.textureMode = 'lru';
      this.cache?.enableLru();
      if (PERF_ENABLED) {
        console.warn('[reader:texture-fallback]', JSON.stringify({
          reason: error.gpuReason || 'gpu-failure',
          message: error.message,
          ...this.textureStats,
        }));
      }
      if (error.contextLost) {
        if (this.contextReloadScheduled) return;
        this.contextReloadScheduled = true;
        window.setTimeout(function () { window.location.reload(); }, 80);
        return;
      }
      this.refreshPaperTextures();
      this.cache.prune();
      this.loadSpreadTextures(this.spread, true).then(() => {
        this.refreshPaperTextures();
        this.requestRender();
      }).catch(function () {});
      this.startPagePrefetch();
      this.logTextureMode(error.gpuReason || 'gpu-failure');
    }

    handleTextureReady(page) {
      this.refreshPaperTextures();
      this.requestRender();
      if (PERF_ENABLED && this.textureMode !== 'lru') {
        console.info('[reader:resident-progress]', JSON.stringify({
          page,
          ...this.textureStats,
        }));
      }
      if (
        this.textureMode === 'resident-loading'
        && this.textureStats.residentTextures === this.totalPages
      ) {
        this.textureMode = 'resident';
        this.cache.mode = 'resident';
        this.logTextureMode('all-textures-uploaded');
      }
    }

    createRenderer() {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        // Keep MSAA disabled: page clarity comes from the native Retina backing
        // buffer and larger source textures, without paying for multisampling.
        antialias: false,
        powerPreference: 'high-performance',
      });
      this.renderer.setClearColor(0xffffff, 0);
      this.renderer.setPixelRatio(this.renderPixelRatio);
      this.renderer.shadowMap.enabled = false;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(30, 1, 4, 50000);
      this.camera.position.set(0, 20, 600);
      this.camera.lookAt(new THREE.Vector3(0, 0, 0));
    }

    createPlaceholderTexture() {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, 4, 4);
      const texture = new THREE.Texture(canvas);
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      return texture;
    }

    createScene(coverTexture) {
      const image = coverTexture.image;
      const ratio = Math.max(
        0.1,
        coverTexture.pageAspect
          || (image.naturalWidth || image.width) / (image.naturalHeight || image.height),
      );
      this.PW = (ratio > 1 ? 1 : ratio) * 297;
      this.PH = 297 / (ratio < 1 ? 1 : ratio);
      this.placeholderTexture = this.createPlaceholderTexture();
      this.viewGroup = new THREE.Group();
      this.bookGroup = new THREE.Group();
      this.scene.add(this.viewGroup);
      this.viewGroup.add(this.bookGroup);

      const ambientLight = new THREE.AmbientLight(0xffffff);
      ambientLight.intensity = 0.8;
      this.scene.add(ambientLight);
      const keyLight = new THREE.DirectionalLight(0xffffff, 0.22);
      keyLight.position.set(-220, 330, 550);
      this.scene.add(keyLight);

      for (let index = 0; index < this.stackCount; index += 1) {
        const paper = new DannyFlipPaper({
          width: this.PW,
          height: this.PH,
          depth: 0.2,
          segments: CONFIG.pageSegments,
          placeholderTexture: this.placeholderTexture,
          castShadow: false,
        });
        paper.index = index;
        paper.angles[1] = 180;
        paper.angles[4] = 180;
        paper.stiffness = (this.stackCount - index) / 100;
        paper.position.z = -index;
        paper.updateAngle();
        this.pages.push(paper);
        this.bookGroup.add(paper);
      }
      this.updatePage(0, false);
      const coverPaper = this.paperForSheet(0);
      coverPaper?.setBackTexture(coverTexture);
      this.bookGroup.position.x = this.centerForView(0, 1);
      this.applyViewTransform();
    }

    async initialize() {
      if (!this.totalPages) throw new Error('No JPEG page manifest was found');
      const cover = await this.texture(1, true, { retainSource: true });
      this.createScene(cover);
      await this.loadSheetTextures(0, true);
      this.refreshPaperTextures();
      if (this.textureMode !== 'lru') this.cache.releaseSource(1);
      this.resize();
      this.requestRender();
      if (this.textureMode === 'lru') this.startPagePrefetch();
      else this.startResidentPreload();
      if (CONFIG.testContextLossAfter && this.textureMode !== 'lru') {
        this.contextLossTimer = window.setTimeout(() => {
          this.renderer.forceContextLoss();
        }, CONFIG.testContextLossAfter);
      }
    }

    texture(page, priority, options) {
      if (page < 1 || page > this.totalPages) {
        return Promise.resolve(this.placeholderTexture || null);
      }
      return this.cache.load(page, priority, options);
    }

    paperForSheet(sheetIndex) {
      return this.pages.find((paper) => paper.sheetIndex === sheetIndex) || null;
    }

    sheetPages(sheetIndex) {
      return { back: sheetIndex * 2 + 1, front: sheetIndex * 2 + 2 };
    }

    visiblePagesForSpread(spread) {
      if (spread <= 0) return [1];
      const first = Math.min(this.totalPages, spread * 2);
      const second = Math.min(this.totalPages, first + 1);
      return first === second ? [first] : [first, second];
    }

    loadSpreadTextures(spread, priority) {
      return this.loadPages(this.visiblePagesForSpread(spread), priority);
    }

    loadPages(pages, priority) {
      return Promise.all(pages.map((page) => this.texture(page, priority)));
    }

    async loadSheetTextures(sheetIndex, priority) {
      const pages = this.sheetPages(sheetIndex);
      const [back, front] = await Promise.all([
        this.texture(pages.back, priority),
        this.texture(pages.front, priority),
      ]);
      const paper = this.paperForSheet(sheetIndex);
      if (paper) {
        paper.setBackTexture(back || this.placeholderTexture);
        paper.setFrontTexture(front || this.placeholderTexture);
      }
      return [pages.back, pages.front].filter(
        (page) => page >= 1 && page <= this.totalPages,
      );
    }

    refreshPaperTextures() {
      const preserveMovingSurface = this.textureMode === 'lru';
      this.pages.forEach((paper) => {
        const pages = this.sheetPages(paper.sheetIndex);
        const back = this.cache.get(pages.back);
        const front = this.cache.get(pages.front);
        // Keep the old surface on a paper that is already moving until
        // the newly assigned texture arrives. This avoids a white flash during
        // overlapping rapid flips.
        if (back || !preserveMovingSurface || !paper.isFlipping) {
          paper.setBackTexture(back || this.placeholderTexture);
        }
        if (front || !preserveMovingSurface || !paper.isFlipping) {
          paper.setFrontTexture(front || this.placeholderTexture);
        }
      });
    }

    safeStiffness(value) {
      return Number.isFinite(value) ? value : 0;
    }

    updatePage(baseNumber, animate) {
      const previousBase = this.oldBaseNumber || 0;
      const sheetCount = this.totalPages / 2;
      const middle = Math.floor(this.stackCount / 2);
      const stackingGap = 0.4;
      const angleGap = 0.02;
      let reverse = false;

      if (animate && previousBase > baseNumber) {
        reverse = true;
        this.pages[this.stackCount - 1].skipFlip = true;
        this.pages.unshift(this.pages.pop());
      } else if (animate && previousBase < baseNumber) {
        this.pages[0].skipFlip = true;
        this.pages.push(this.pages.shift());
      }

      const remaining = sheetCount - baseNumber;
      const leftDepth = 5 / sheetCount * baseNumber / 2;
      const rightDepth = 5 / sheetCount * remaining / 2;
      const maximumDepth = Math.max(leftDepth, rightDepth);
      const stackCurve = (
        0.5 - Math.abs(sheetCount / 2 - baseNumber) / sheetCount
      ) / this.stiffness;
      let flip = null;

      for (let index = 0; index < this.stackCount; index += 1) {
        const paper = this.pages[index];
        const previousAngle = paper.angles[1];
        const sheetIndex = baseNumber - middle + index;
        paper.sheetIndex = sheetIndex;
        paper.isEdge = false;
        paper.depth = index === 0
          ? Math.max(stackingGap, leftDepth)
          : index === this.stackCount - 1
            ? Math.max(stackingGap, rightDepth)
            : stackingGap;
        if (paper.isFlipping) paper.depth = stackingGap;
        paper.position.x = 0;

        const leftAngle = angleGap * index;
        const rightAngle = 180 - angleGap * (index - middle) + angleGap * index;
        const targetAngle = index < middle ? leftAngle : rightAngle;
        if (index < middle) {
          paper.newStiffness = this.safeStiffness(
            stackCurve / (baseNumber / sheetCount) / 4,
          );
          paper.position.z = maximumDepth - (-index + middle) * stackingGap;
          if (reverse) paper.position.z -= stackingGap;
        } else {
          paper.newStiffness = this.safeStiffness(
            stackCurve / (Math.abs(sheetCount - baseNumber) / sheetCount) / 4,
          );
          paper.position.z = maximumDepth
            - (-this.stackCount + index + middle + 1) * stackingGap
            - paper.depth;
        }

        if (paper.isFlipping) {
          // Remap and depth-sort an in-flight paper while its tween keeps
          // sole ownership of angles and geometry until completion.
        } else if (animate && Math.abs(previousAngle - targetAngle) > 20 && !paper.skipFlip) {
          paper.depth = stackingGap;
          const transitionStiffness = previousAngle > targetAngle
            ? stackCurve / (Math.abs(sheetCount - baseNumber) / sheetCount) / 4
            : stackCurve / (baseNumber / sheetCount) / 4;
          paper.position.z += stackingGap;
          paper.stiffness = this.safeStiffness(transitionStiffness);
          paper.updateAngle();
          const targetStiffness = this.safeStiffness(
            index < baseNumber
              ? stackCurve / (Math.abs(sheetCount - baseNumber) / sheetCount) / 4
              : stackCurve / (baseNumber / sheetCount) / 4,
          );
          paper.isFlipping = true;
          flip = { paper, from: previousAngle, to: targetAngle, targetStiffness };
        } else {
          paper.skipFlip = false;
          paper.angles[1] = targetAngle;
          paper.angles[4] = targetAngle;
          paper.stiffness = paper.newStiffness;
          paper.updateAngle();
        }

        paper.visible = (
          sheetIndex >= 0 && sheetIndex < sheetCount
        ) || paper.isFlipping;
        paper.oldDepth = paper.depth;
      }
      this.oldBaseNumber = baseNumber;
      return flip;
    }

    interpolateKeyframes(values, progress) {
      const scaled = clamp(progress, 0, 1) * (values.length - 1);
      const index = Math.min(values.length - 2, Math.floor(scaled));
      const local = scaled - index;
      return values[index] + (values[index + 1] - values[index]) * local;
    }

    flipFrameValues(flip) {
      if (flip.frameValues) return flip.frameValues;
      const delta = flip.to - flip.from;
      const startsOnLeft = flip.from > 90;
      flip.frameValues = {
        startsOnLeft,
        angles: [
          flip.from,
          flip.from + delta / 4,
          flip.from + delta * 2 / 4,
          flip.from + delta * 3 / 4,
          flip.to,
        ],
        secondaryAngles: startsOnLeft
          ? [180, 90, 45, 0, 0]
          : [0, 90, 135, 180, 180],
        stiffnesses: [
          flip.paper.stiffness,
          flip.paper.stiffness,
          flip.paper.newStiffness,
          flip.paper.newStiffness,
          flip.paper.newStiffness,
        ],
      };
      return flip.frameValues;
    }

    applyFlipProgress(flip, paperProgress, fromCenter, toCenter, centerProgress) {
      const values = this.flipFrameValues(flip);
      const paper = flip.paper;
      paper.angles[1] = this.interpolateKeyframes(values.angles, paperProgress);
      paper.angles[4] = this.interpolateKeyframes(values.secondaryAngles, paperProgress);
      paper.stiffness = this.interpolateKeyframes(values.stiffnesses, paperProgress);
      paper.updateAngle();
      this.bookGroup.position.x = fromCenter
        + (toCenter - fromCenter) * clamp(centerProgress, 0, 1);
      this.requestRender();
    }

    centerForSpread(spread) {
      if (spread === 0) return -this.PW / 2;
      if (spread === this.maxSpread) return this.PW / 2;
      return 0;
    }

    spreadForPage(page) {
      return page <= 1 ? 0 : Math.floor(page / 2);
    }

    centerForView(spread, activePage) {
      if (this.pageMode !== 'single') return this.centerForSpread(spread);
      return activePage % 2 === 0 ? this.PW / 2 : -this.PW / 2;
    }

    visiblePageCount() {
      if (this.pageMode === 'single') return 1;
      return this.visiblePagesForSpread(this.spread).length;
    }

    isZoomed() {
      return this.zoomScale > ZOOM_MINIMUM + 0.001;
    }

    clampPan() {
      const contentWidth = this.PW * this.visiblePageCount();
      const contentHeight = this.PH;
      const maximumX = Math.max(
        0,
        (contentWidth * this.modelScale * this.zoomScale - this.viewWidth) / 2
          / Math.max(0.001, this.modelScale),
      );
      const maximumY = Math.max(
        0,
        (contentHeight * this.modelScale * this.zoomScale - this.viewHeight) / 2
          / Math.max(0.001, this.modelScale),
      );
      this.panX = clamp(this.panX, -maximumX, maximumX);
      this.panY = clamp(this.panY, -maximumY, maximumY);
    }

    applyViewTransform() {
      if (!this.viewGroup) return;
      this.clampPan();
      this.viewGroup.scale.set(this.zoomScale, this.zoomScale, this.zoomScale);
      this.viewGroup.position.set(this.panX, this.panY, 0);
      this.requestRender();
      this.pageLinks?.positionLinks();
    }

    setZoom(scale) {
      if (
        !this.viewGroup
        || this.dragState
        || this.activeAnimations
        || this.pendingNavigation
      ) return;
      const nextScale = clamp(scale, ZOOM_MINIMUM, ZOOM_MAXIMUM);
      if (Math.abs(nextScale - this.zoomScale) < 0.001) return;
      this.zoomScale = nextScale;
      if (!this.isZoomed()) {
        this.panX = 0;
        this.panY = 0;
      }
      this.applyViewTransform();
      updateControls();
    }

    zoomBy(delta) {
      this.setZoom(this.zoomScale + delta);
    }

    togglePageMode() {
      if (this.isZoomed() || this.dragState || this.activeAnimations || this.pendingNavigation) return;
      this.pageMode = this.pageMode === 'double' ? 'single' : 'double';
      state.pageMode = this.pageMode;
      this.activePage = this.pageMode === 'single'
        ? this.spread === 0 ? 1 : Math.min(this.totalPages, this.spread * 2)
        : this.spread === 0 ? 1 : Math.min(this.totalPages, this.spread * 2 + 1);
      this.panX = 0;
      this.panY = 0;
      this.bookGroup.position.x = this.centerForView(this.spread, this.activePage);
      applyLayout('page-mode');
      updateControls();
      this.requestRender();
    }

    animateViewCenter(targetPage) {
      if (this.activeAnimations || this.dragState) return;
      const fromCenter = this.bookGroup.position.x;
      const toCenter = this.centerForView(this.spread, targetPage);
      const duration = REDUCED_MOTION ? 0 : 240;
      const startedAt = performance.now();
      const token = ++this.centerAnimationToken;
      this.activePage = targetPage;
      this.activeAnimations += 1;
      updateControls();

      const finish = () => {
        if (token === this.centerAnimationToken) this.bookGroup.position.x = toCenter;
        this.activeAnimations = Math.max(0, this.activeAnimations - 1);
        updateControls();
        this.requestRender();
      };
      if (!duration || Math.abs(toCenter - fromCenter) < 0.001) {
        finish();
        return;
      }
      const tick = (now) => {
        if (token !== this.centerAnimationToken) {
          this.activeAnimations = Math.max(0, this.activeAnimations - 1);
          return;
        }
        const raw = Math.min(1, (now - startedAt) / duration);
        const progress = easeInOutCubic(raw);
        this.bookGroup.position.x = fromCenter + (toCenter - fromCenter) * progress;
        this.requestRender();
        if (raw < 1) window.requestAnimationFrame(tick);
        else finish();
      };
      window.requestAnimationFrame(tick);
    }

    animateFlip(flip, fromCenter, toCenter, direction, centerToken) {
      return new Promise((resolve) => {
        const paper = flip.paper;
        const values = this.flipFrameValues(flip);
        const startedAt = performance.now();
        let previousFrameAt = startedAt;
        let frameCount = 0;
        let droppedFrames = 0;
        let maximumFrameDelta = 0;

        const tick = (now) => {
          const frameDelta = now - previousFrameAt;
          previousFrameAt = now;
          frameCount += 1;
          if (frameDelta > 34) droppedFrames += 1;
          maximumFrameDelta = Math.max(maximumFrameDelta, frameDelta);
          const raw = Math.min(1, (now - startedAt) / Math.max(1, this.duration));
          const paperProgress = Math.sin(raw * Math.PI / 2);
          const centerProgress = easeInOutCubic(raw);
          if (centerToken === this.centerAnimationToken) {
            this.applyFlipProgress(
              flip,
              paperProgress,
              fromCenter,
              toCenter,
              centerProgress,
            );
          } else {
            paper.angles[1] = this.interpolateKeyframes(values.angles, paperProgress);
            paper.angles[4] = this.interpolateKeyframes(
              values.secondaryAngles,
              paperProgress,
            );
            paper.stiffness = this.interpolateKeyframes(
              values.stiffnesses,
              paperProgress,
            );
            paper.updateAngle();
            this.requestRender();
          }
          if (raw < 1) {
            window.requestAnimationFrame(tick);
          } else {
            paper.stiffness = paper.newStiffness;
            paper.angles[1] = flip.to;
            paper.angles[4] = values.startsOnLeft ? 0 : 180;
            paper.updateAngle();
            paper.isFlipping = false;
            if (centerToken === this.centerAnimationToken) {
              this.bookGroup.position.x = toCenter;
            }
            this.requestRender();
            if (PERF_ENABLED) {
              console.info('[reader:flip]', JSON.stringify({
                direction: direction > 0 ? 'next' : 'prev',
                spread: this.spread,
                durationMs: Math.round(performance.now() - startedAt),
                frames: frameCount,
                droppedFrames,
                maxFrameDeltaMs: Math.round(maximumFrameDelta),
                drawObjects: this.pages.filter((page) => page.visible).length,
                geometry: 'danny-flip-paper',
              }));
            }
            resolve();
          }
        };
        window.requestAnimationFrame(tick);
      });
    }

    canNavigate(direction) {
      if (this.isZoomed()) return false;
      if (this.pageMode === 'single') {
        return direction > 0 ? this.activePage < this.totalPages : this.activePage > 1;
      }
      return direction > 0 ? this.spread < this.maxSpread : this.spread > 0;
    }

    navigate(direction) {
      const normalized = direction > 0 ? 1 : -1;
      if (this.dragState || this.isZoomed()) return;
      if (!this.canNavigate(normalized)) return;
      this.pageLinks.interrupt();
      if (this.pageMode === 'single') {
        if (this.activeAnimations || this.pendingNavigation) return;
        const targetPage = this.activePage + normalized;
        const targetSpread = this.spreadForPage(targetPage);
        if (targetSpread === this.spread) {
          this.animateViewCenter(targetPage);
        } else {
          this.runNavigation(normalized, targetPage);
        }
        return;
      }
      this.runNavigation(normalized, null);
    }

    runNavigation(direction, requestedTargetPage) {
      const previousSpread = this.spread;
      const previousActivePage = this.activePage;
      try {
        if (this.textureMode === 'lru' && (this.activeAnimations || this.pendingNavigation)) return;
        const targetSpread = previousSpread + direction;
        const targetActivePage = requestedTargetPage || (
          targetSpread === 0 ? 1 : Math.min(this.totalPages, targetSpread * 2 + 1)
        );
        const targetPages = this.visiblePagesForSpread(targetSpread);
        const flippingSheet = direction > 0 ? previousSpread : targetSpread;
        const protectedPages = Object.values(this.sheetPages(flippingSheet)).filter(
          (page) => page >= 1 && page <= this.totalPages,
        );
        const requiredPages = Array.from(new Set([...targetPages, ...protectedPages]));
        const requiredTexturesReady = requiredPages.every((page) => this.cache.get(page));
        if (this.textureMode === 'lru' && !requiredTexturesReady) {
          const startedAt = performance.now();
          this.pendingNavigation = {
            direction,
            previousSpread,
            targetSpread,
            targetActivePage,
          };
          this.bufferingLoads += 1;
          setBuffering(true);
          updateControls();
          this.loadPages(requiredPages, true).then(() => {
            this.refreshPaperTextures();
            this.requestRender();
            if (PERF_ENABLED) {
              console.info('[reader:navigation-ready]', JSON.stringify({
                targetSpread,
                pages: targetPages,
                durationMs: Math.round(performance.now() - startedAt),
              }));
            }
            this.pendingNavigation = null;
            if (this.spread === previousSpread) {
              this.runNavigation(direction, targetActivePage);
            }
          }).catch((error) => {
            console.warn('[reader:navigation]', error);
          }).finally(() => {
            this.pendingNavigation = null;
            this.bufferingLoads = Math.max(0, this.bufferingLoads - 1);
            setBuffering(this.bufferingLoads > 0);
            updateControls();
          });
          return;
        }
        if (this.textureMode !== 'lru' && !requiredTexturesReady) {
          this.loadPages(requiredPages, true).catch((error) => {
            if (error.gpuFailure) return;
            if (PERF_ENABLED) console.warn('[reader:navigation-white]', error);
          });
        }
        const fromCenter = this.bookGroup.position.x;
        const toCenter = this.centerForView(targetSpread, targetActivePage);
        const flip = this.updatePage(targetSpread, true);
        this.refreshPaperTextures();
        if (!flip) throw new Error('No page sheet is available for the requested turn');

        this.spread = targetSpread;
        this.activePage = targetActivePage;
        updateControls();
        this.animationPages.set(flip.paper, new Set(protectedPages));
        this.activeAnimations += 1;
        updateControls();
        const centerToken = ++this.centerAnimationToken;

        this.animateFlip(flip, fromCenter, toCenter, direction, centerToken).then(() => {
          this.animationPages.delete(flip.paper);
          this.activeAnimations = Math.max(0, this.activeAnimations - 1);
          this.updatePage(this.spread, false);
          this.refreshPaperTextures();
          this.cache.prune();
          updateControls();
          this.requestRender();
        }).catch((error) => {
          this.animationPages.delete(flip.paper);
          this.activeAnimations = Math.max(0, this.activeAnimations - 1);
          showReaderError(error);
        });
      } catch (error) {
        this.spread = previousSpread;
        this.activePage = previousActivePage;
        setBuffering(false);
        updateControls();
        showReaderError(error);
      }
    }

    protectedPages() {
      const pages = new Set();
      this.animationPages.forEach((animationPages) => {
        animationPages.forEach((page) => pages.add(page));
      });
      const center = this.spread === 0 ? 1 : this.spread * 2;
      for (let offset = -3; offset <= 4; offset += 1) pages.add(center + offset);
      return Array.from(pages).filter((page) => page >= 1 && page <= this.totalPages);
    }

    backgroundTurn() {
      return new Promise((resolve) => {
        if (window.scheduler?.postTask) {
          window.scheduler.postTask(resolve, { priority: 'background' }).catch(function () {
            window.setTimeout(resolve, 0);
          });
        } else if (window.requestIdleCallback) {
          window.requestIdleCallback(function () { resolve(); }, { timeout: 1000 });
        } else {
          window.setTimeout(resolve, 32);
        }
      });
    }

    startResidentPreload() {
      if (this.residentPreloadPromise) return this.residentPreloadPromise;
      let nextPage = 1;
      const worker = async () => {
        while (!this.residentLoaderCancelled && nextPage <= this.totalPages) {
          const page = nextPage;
          nextPage += 1;
          try {
            await this.texture(page, false);
          } catch (error) {
            if (error.gpuFailure || this.residentLoaderCancelled) break;
          }
          await this.backgroundTurn();
        }
      };
      this.residentPreloadPromise = Promise.all([worker(), worker()]);
      return this.residentPreloadPromise;
    }

    startPagePrefetch() {
      if (this.prefetchPromise) return this.prefetchPromise;
      this.prefetchAbortController = new AbortController();
      const signal = this.prefetchAbortController.signal;
      this.prefetchPromise = (async () => {
        const startedAt = performance.now();
        let completed = 0;
        let failed = 0;
        await this.backgroundTurn();
        for (let index = 0; index < this.pageUrls.length; index += 1) {
          if (signal.aborted) break;
          const page = index + 1;
          try {
            const response = await fetch(this.pageUrls[index], {
              cache: 'force-cache',
              credentials: 'same-origin',
              priority: 'low',
              signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await response.blob();
            completed += 1;
          } catch (error) {
            if (signal.aborted) break;
            failed += 1;
            if (PERF_ENABLED) console.warn(`[reader:prefetch] page ${page}`, error);
          }
          await this.backgroundTurn();
        }
        if (PERF_ENABLED) {
          console.info('[reader:prefetch]', JSON.stringify({
            completed,
            failed,
            total: this.pageUrls.length,
            durationMs: Math.round(performance.now() - startedAt),
          }));
        }
      })();
      return this.prefetchPromise;
    }

    pointerPoint(event) {
      const bounds = this.canvas.getBoundingClientRect();
      const rotated = state.layout === 'portrait-rotated'
        || state.layout === 'portrait-stage-rotated';
      return {
        axis: rotated ? event.clientY - bounds.top : event.clientX - bounds.left,
        crossAxis: rotated ? bounds.right - event.clientX : event.clientY - bounds.top,
        extent: Math.max(1, rotated ? bounds.height : bounds.width),
      };
    }

    updatePointerPan(pointer, point) {
      const scale = Math.max(0.001, this.modelScale);
      this.panX = pointer.panStartX + (point.axis - pointer.startAxis) / scale;
      this.panY = pointer.panStartY + (point.crossAxis - pointer.startCrossAxis) / scale;
      this.applyViewTransform();
    }

    startPointerDrag(direction) {
      if (
        !this.bookGroup
        || this.dragState
        || this.activeAnimations
        || this.pendingNavigation
        || !this.canNavigate(direction)
      ) return null;

      const previousSpread = this.spread;
      const previousPage = this.activePage;
      const targetPage = this.pageMode === 'single'
        ? previousPage + direction
        : previousSpread + direction === 0
          ? 1
          : Math.min(this.totalPages, (previousSpread + direction) * 2 + 1);
      const targetSpread = this.pageMode === 'single'
        ? this.spreadForPage(targetPage)
        : previousSpread + direction;
      const fromCenter = this.bookGroup.position.x;
      const toCenter = this.centerForView(targetSpread, targetPage);

      if (targetSpread === previousSpread) {
        const viewDrag = {
          type: 'view',
          direction,
          previousSpread,
          targetSpread,
          previousPage,
          targetPage,
          fromCenter,
          toCenter,
          progress: 0,
          startedAt: performance.now(),
        };
        this.dragState = viewDrag;
        this.activeAnimations += 1;
        return viewDrag;
      }

      const targetPages = this.visiblePagesForSpread(targetSpread);
      const flippingSheet = direction > 0 ? previousSpread : targetSpread;
      const protectedPages = Object.values(this.sheetPages(flippingSheet)).filter(
        (page) => page >= 1 && page <= this.totalPages,
      );
      const requiredPages = Array.from(new Set([...targetPages, ...protectedPages]));
      const flip = this.updatePage(targetSpread, true);

      if (!flip) {
        this.updatePage(previousSpread, false);
        this.refreshPaperTextures();
        this.bookGroup.position.x = this.centerForView(previousSpread, previousPage);
        this.requestRender();
        return null;
      }

      const drag = {
        type: 'flip',
        direction,
        previousSpread,
        targetSpread,
        previousPage,
        targetPage,
        flip,
        fromCenter,
        toCenter,
        progress: 0,
        startedAt: performance.now(),
      };
      this.dragState = drag;
      this.animationPages.set(flip.paper, new Set(protectedPages));
      this.activeAnimations += 1;
      this.refreshPaperTextures();
      this.applyFlipProgress(flip, 0, fromCenter, toCenter, 0);

      const missingPages = requiredPages.filter((page) => !this.cache.get(page));
      if (missingPages.length) {
        this.bufferingLoads += 1;
        setBuffering(true);
        this.loadPages(missingPages, true).then(() => {
          this.refreshPaperTextures();
          this.requestRender();
        }).catch((error) => {
          if (!error.gpuFailure) console.warn('[reader:drag-texture]', error);
        }).finally(() => {
          this.bufferingLoads = Math.max(0, this.bufferingLoads - 1);
          setBuffering(this.bufferingLoads > 0);
        });
      }
      return drag;
    }

    applyPointerDragProgress(drag, progress) {
      if (drag.type === 'view') {
        this.bookGroup.position.x = drag.fromCenter
          + (drag.toCenter - drag.fromCenter) * progress;
        this.requestRender();
        return;
      }
      this.applyFlipProgress(
        drag.flip,
        progress,
        drag.fromCenter,
        drag.toCenter,
        progress,
      );
    }

    updatePointerDrag(pointer, point) {
      const drag = this.dragState;
      if (!drag) return;
      const distance = point.axis - pointer.startAxis;
      const directionalDistance = drag.direction > 0 ? -distance : distance;
      const pageWidth = this.lastPageWidth || point.extent / 2;
      const travel = Math.max(1, pageWidth * (this.pageMode === 'single' ? 1 : 2));
      drag.progress = clamp(directionalDistance / travel, 0, 1);
      drag.thresholdProgress = (
        this.profile.handheld ? HANDHELD_DRAG_THRESHOLD : POINTER_DRAG_THRESHOLD
      ) / travel;
      this.applyPointerDragProgress(drag, drag.progress);
    }

    settlePointerDrag(drag, commit) {
      if (!drag || this.dragState !== drag) return;
      const destination = commit ? 1 : 0;
      const startProgress = drag.progress;
      const distance = Math.abs(destination - startProgress);
      const duration = distance < 0.001
        ? 0
        : clamp(this.duration * distance, 140, this.duration);
      const startedAt = performance.now();

      if (commit) {
        this.spread = drag.targetSpread;
        this.activePage = drag.targetPage;
        updateControls();
      }

      const finish = () => {
        const finalSpread = commit ? drag.targetSpread : drag.previousSpread;
        const finalPage = commit ? drag.targetPage : drag.previousPage;
        if (drag.type === 'flip') {
          drag.flip.paper.isFlipping = false;
          this.animationPages.delete(drag.flip.paper);
        }
        this.activeAnimations = Math.max(0, this.activeAnimations - 1);
        this.spread = finalSpread;
        this.activePage = finalPage;
        if (drag.type === 'flip') {
          this.updatePage(finalSpread, false);
          this.refreshPaperTextures();
        }
        this.bookGroup.position.x = this.centerForView(finalSpread, finalPage);
        this.dragState = null;
        this.cache.prune();
        updateControls();
        this.requestRender();
        if (PERF_ENABLED) {
          console.info('[reader:drag]', JSON.stringify({
            direction: drag.direction > 0 ? 'next' : 'prev',
            committed: commit,
            releasedProgress: Number(startProgress.toFixed(3)),
            settleDurationMs: Math.round(performance.now() - startedAt),
          }));
        }
      };

      if (!duration) {
        this.applyPointerDragProgress(drag, destination);
        finish();
        return;
      }

      const tick = (now) => {
        const raw = Math.min(1, (now - startedAt) / duration);
        const eased = Math.sin(raw * Math.PI / 2);
        const progress = startProgress + (destination - startProgress) * eased;
        this.applyPointerDragProgress(drag, progress);
        if (raw < 1) window.requestAnimationFrame(tick);
        else finish();
      };
      window.requestAnimationFrame(tick);
    }

    bindPointerInput() {
      this.canvas.addEventListener('pointerdown', (event) => {
        if (
          event.button > 0
          || event.isPrimary === false
          || this.pointer
          || !this.bookGroup
        ) return;
        this.pageLinks.interrupt();
        const point = this.pointerPoint(event);
        const now = performance.now();
        this.pointer = {
          id: event.pointerId,
          startAxis: point.axis,
          startCrossAxis: point.crossAxis,
          panStartX: this.panX,
          panStartY: this.panY,
          lastAxis: point.axis,
          lastAt: now,
          velocity: 0,
          gesture: false,
          mode: this.isZoomed() ? 'panning' : 'candidate',
        };
        if (this.isZoomed()) this.canvas.classList.add('is-panning');
        this.canvas.setPointerCapture?.(event.pointerId);
      });
      this.canvas.addEventListener('pointermove', (event) => {
        const pointer = this.pointer;
        if (!pointer || pointer.id !== event.pointerId) return;
        const point = this.pointerPoint(event);
        const now = performance.now();
        const elapsed = now - pointer.lastAt;
        if (elapsed > 0 && elapsed <= 100) {
          pointer.velocity = (point.axis - pointer.lastAxis) / elapsed;
        } else if (elapsed > 100) {
          pointer.velocity = 0;
        }
        pointer.lastAxis = point.axis;
        pointer.lastAt = now;

        const axisDistance = point.axis - pointer.startAxis;
        const crossDistance = point.crossAxis - pointer.startCrossAxis;
        const threshold = this.profile.handheld
          ? HANDHELD_DRAG_THRESHOLD
          : POINTER_DRAG_THRESHOLD;

        if (pointer.mode === 'panning') {
          pointer.gesture = true;
          this.updatePointerPan(pointer, point);
          event.preventDefault();
          return;
        }
        if (pointer.mode === 'dragging') {
          this.updatePointerDrag(pointer, point);
          event.preventDefault();
          return;
        }
        if (Math.hypot(axisDistance, crossDistance) <= threshold) return;

        pointer.gesture = true;
        if (Math.abs(axisDistance) < Math.abs(crossDistance)) {
          pointer.mode = 'blocked';
          return;
        }
        const drag = this.startPointerDrag(axisDistance < 0 ? 1 : -1);
        if (!drag) {
          pointer.mode = 'blocked';
          return;
        }
        pointer.mode = 'dragging';
        this.canvas.classList.add('is-dragging');
        this.updatePointerDrag(pointer, point);
        event.preventDefault();
      }, { passive: false });
      const release = (event) => {
        const pointer = this.pointer;
        if (!pointer || pointer.id !== event.pointerId) return;
        const point = this.pointerPoint(event);
        this.pointer = null;
        this.canvas.classList.remove('is-dragging');
        this.canvas.classList.remove('is-panning');
        if (pointer.mode === 'panning') {
          this.updatePointerPan(pointer, point);
          this.pageLinks.sync();
          return;
        }
        if (pointer.mode === 'dragging' && this.dragState) {
          this.updatePointerDrag(pointer, point);
          const recentVelocity = performance.now() - pointer.lastAt <= 100
            ? pointer.velocity
            : 0;
          const directionalVelocity = this.dragState.direction > 0
            ? -recentVelocity
            : recentVelocity;
          const commit = this.dragState.progress >= DRAG_COMMIT_PROGRESS || (
            this.dragState.progress >= Math.max(0.02, this.dragState.thresholdProgress)
            && directionalVelocity >= DRAG_FLICK_VELOCITY
          );
          this.settlePointerDrag(this.dragState, commit);
          return;
        }
        if (pointer.gesture) {
          this.pageLinks.sync();
          return;
        }
        this.navigate(point.axis >= point.extent / 2 ? 1 : -1);
        this.pageLinks.sync();
      };
      this.canvas.addEventListener('pointerup', release);
      this.canvas.addEventListener('pointercancel', (event) => {
        const pointer = this.pointer;
        if (!pointer || pointer.id !== event.pointerId) return;
        this.pointer = null;
        this.canvas.classList.remove('is-dragging');
        this.canvas.classList.remove('is-panning');
        if (pointer.mode === 'dragging' && this.dragState) {
          this.settlePointerDrag(this.dragState, false);
        } else {
          this.pageLinks.sync();
        }
      });
    }

    async goToSpread(spread) {
      if (
        this.isZoomed()
        || this.activeAnimations
        || (this.textureMode === 'lru' && this.pendingNavigation)
      ) return;
      const target = clamp(spread, 0, this.maxSpread);
      if (target === this.spread) return;
      this.pageLinks.interrupt();
      if (this.textureMode === 'lru') {
        this.pendingNavigation = { direct: true, targetSpread: target };
        this.bufferingLoads += 1;
        setBuffering(true);
        try {
          await this.loadSpreadTextures(target, true);
        } catch (error) {
          console.warn('[reader:navigation]', error);
          return;
        } finally {
          this.pendingNavigation = null;
          this.bufferingLoads = Math.max(0, this.bufferingLoads - 1);
          setBuffering(this.bufferingLoads > 0);
        }
      } else {
        this.loadSpreadTextures(target, true).catch(function () {});
      }
      this.oldBaseNumber = target;
      this.spread = target;
      this.activePage = this.pageMode === 'single'
        ? target === 0 ? 1 : Math.min(this.totalPages, target * 2)
        : target === 0 ? 1 : Math.min(this.totalPages, target * 2 + 1);
      this.updatePage(target, false);
      this.refreshPaperTextures();
      this.bookGroup.position.x = this.centerForView(target, this.activePage);
      updateControls();
      this.requestRender();
    }

    requestRender() {
      if (this.renderFrame || !this.bookGroup) return;
      this.renderFrame = window.requestAnimationFrame(() => {
        this.renderFrame = 0;
        this.renderer.render(this.scene, this.camera);
      });
    }

    resize() {
      if (!this.bookGroup) return;
      const stage = this.canvas.parentElement;
      const width = Math.max(1, stage?.clientWidth || this.canvas.clientWidth);
      // The controls occupy their own edge in landscape and side-bar layouts.
      // Always cap against the actual stage instead of the outer window so a
      // short viewport cannot hide the top or bottom of the fitted page.
      const maximumHeight = Math.max(1, Math.round(
        stage?.clientHeight || this.canvas.clientHeight,
      ));

      // Preserve the reader's `height: auto` sizing path. When width is the
      // limiting dimension, shorten the WebGL canvas
      // to the fitted book height plus 10px padding on each side. Keeping the
      // outer stage full-height leaves the same background/control layout.
      const padding = 20;
      const availableWidth = Math.max(1, width - padding);
      const availableHeight = Math.max(1, maximumHeight - padding);
      const pageSpan = this.pageMode === 'single' ? 1 : 2;
      const widthBudget = Math.ceil(availableWidth / pageSpan);
      const widthLimitedHeight = widthBudget / (this.PW / this.PH);
      const heightLimited = widthLimitedHeight > availableHeight;
      const pageHeight = heightLimited ? availableHeight : Math.ceil(widthLimitedHeight);
      const pageWidth = heightLimited
        ? Math.floor(pageHeight * (this.PW / this.PH))
        : widthBudget;
      const height = Math.min(maximumHeight, Math.max(320, pageHeight + padding));

      this.lastPageWidth = pageWidth;
      this.canvas.style.height = `${height}px`;
      const edgeTop = `${Math.max(1, stage?.clientHeight || height) / 2}px`;
      const edgePrevious = document.getElementById('reader-edge-prev');
      const edgeNext = document.getElementById('reader-edge-next');
      if (edgePrevious) edgePrevious.style.top = edgeTop;
      if (edgeNext) edgeNext.style.top = edgeTop;
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();

      const modelScale = pageHeight / this.PH;
      const verticalFit = (pageHeight + padding) / modelScale;
      const horizontalFit = (pageWidth * pageSpan + padding)
        / modelScale / (width / height);
      const fitSize = heightLimited ? verticalFit : horizontalFit;
      const distance = 1 / (
        2 * Math.tan(Math.PI * this.camera.fov * 0.5 / 180) / fitSize
      ) + 2.2;
      this.camera.position.set(0, 0, distance);
      this.camera.lookAt(new THREE.Vector3(0, 0, 0));
      this.camera.updateProjectionMatrix();
      this.modelScale = modelScale;
      this.viewWidth = width;
      this.viewHeight = height;
      this.bookGroup.position.x = this.centerForView(this.spread, this.activePage);
      this.applyViewTransform();
      this.positionControlDock();
      this.pageLinks.sync();
      this.requestRender();
    }

    positionControlDock() {
      const controls = document.getElementById('reader-controls');
      const shell = document.getElementById('reader-shell');
      if (!controls || !shell) return;
      if (state.layout !== 'portrait-stage-rotated') {
        controls.style.removeProperty('top');
        return;
      }

      const shellHeight = Math.max(1, shell.clientHeight);
      const dockHeight = Math.max(1, controls.offsetHeight || READER_CONTROLS_EDGE);
      const margin = 12;
      const gap = 12;
      const visiblePages = this.spread === 0 || this.spread * 2 >= this.totalPages ? 1 : 2;
      const bookHalfHeight = Math.min(shellHeight / 2, (this.lastPageWidth || 0) * visiblePages / 2);
      const below = shellHeight / 2 + bookHalfHeight + gap;
      const above = shellHeight / 2 - bookHalfHeight - gap - dockHeight;
      const maximumTop = Math.max(margin, shellHeight - dockHeight - margin);
      const top = below <= maximumTop
        ? below
        : above >= margin
          ? above
          : Math.min(maximumTop, Math.max(margin, below));
      controls.style.top = `${Math.round(top)}px`;
    }

    dispose() {
      window.cancelAnimationFrame(this.renderFrame);
      window.clearTimeout(this.contextLossTimer);
      this.residentLoaderCancelled = true;
      this.pointer = null;
      this.dragState = null;
      this.canvas.classList.remove('is-dragging');
      this.canvas.classList.remove('is-panning');
      this.prefetchAbortController?.abort();
      this.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
      this.pageLinks.dispose();
      this.cache.dispose();
      this.placeholderTexture?.dispose();
      this.pages.forEach((paper) => paper.dispose());
      this.renderer.dispose();
    }
  }

  function setBuffering(buffering) {
    const controls = document.getElementById('reader-controls');
    if (!controls) return;
    controls.setAttribute('aria-busy', buffering ? 'true' : 'false');
  }

  function visiblePageState() {
    const book = state.book;
    if (!book) return { current: '1', total: '…', label: 'Page 1; total loading' };
    if (book.pageMode === 'single') {
      return {
        current: String(book.activePage),
        total: String(book.totalPages),
        label: `Page ${book.activePage} of ${book.totalPages}`,
      };
    }
    if (book.spread === 0) {
      return {
        current: '1',
        total: String(book.totalPages),
        label: `Page 1 of ${book.totalPages}`,
      };
    }
    const first = book.spread * 2;
    const second = Math.min(first + 1, book.totalPages);
    const current = first === second ? String(first) : `${first}–${second}`;
    return {
      current,
      total: String(book.totalPages),
      label: first === second
        ? `Page ${first} of ${book.totalPages}`
        : `Pages ${first} to ${second} of ${book.totalPages}`,
    };
  }

  function updateControls() {
    const book = state.book;
    const previous = document.getElementById('reader-prev');
    const next = document.getElementById('reader-next');
    const edgePrevious = document.getElementById('reader-edge-prev');
    const edgeNext = document.getElementById('reader-edge-next');
    const status = document.getElementById('reader-page-status');
    const currentPage = document.getElementById('reader-current-page');
    const totalPages = document.getElementById('reader-total-pages');
    const zoomOut = document.getElementById('reader-zoom-out');
    const zoomIn = document.getElementById('reader-zoom-in');
    const pageMode = document.getElementById('reader-page-mode');
    const canvas = document.getElementById('book-canvas');
    const layoutStatus = document.getElementById('reader-layout-status');
    if (previous) previous.disabled = !book || !book.canNavigate(-1);
    if (next) next.disabled = !book || !book.canNavigate(1);
    if (edgePrevious) edgePrevious.disabled = !book || !book.canNavigate(-1);
    if (edgeNext) edgeNext.disabled = !book || !book.canNavigate(1);
    if (zoomOut) {
      zoomOut.disabled = !book || book.activeAnimations > 0 || book.pendingNavigation
        || book.zoomScale <= ZOOM_MINIMUM;
    }
    if (zoomIn) {
      zoomIn.disabled = !book || book.activeAnimations > 0 || book.pendingNavigation
        || book.zoomScale >= ZOOM_MAXIMUM;
    }
    if (pageMode) {
      pageMode.disabled = !book || book.isZoomed() || book.activeAnimations > 0
        || Boolean(book.pendingNavigation);
      const single = book?.pageMode === 'single';
      pageMode.setAttribute('aria-pressed', single ? 'true' : 'false');
      pageMode.setAttribute('aria-label', single ? 'Switch to spread view' : 'Switch to single-page view');
      pageMode.title = single ? 'Spread view' : 'Single-page view';
    }
    if (canvas) {
      canvas.setAttribute(
        'aria-label',
        book?.isZoomed()
          ? `3D document at ${Math.round(book.zoomScale * 100)}% zoom; drag to pan`
          : `3D document in ${book?.pageMode === 'single' ? 'single-page' : 'spread'} view; click or drag to turn pages`,
      );
    }
    const pageState = visiblePageState();
    if (currentPage) currentPage.textContent = pageState.current;
    if (totalPages) totalPages.textContent = pageState.total;
    if (status) status.setAttribute('aria-label', pageState.label);
    if (layoutStatus) {
      const layoutLabel = state.layout === 'portrait-single'
        ? `${book?.pageMode === 'single' ? 'Single-page' : 'Spread'} portrait layout without rotation`
        : state.layout === 'portrait-stage-rotated'
          ? 'Portrait layout with rotated stage and floating controls'
          : state.layout === 'portrait-rotated'
            ? 'Portrait layout with rotated reader and side controls'
            : book?.pageMode === 'single'
              ? 'Single-page landscape layout'
              : 'Spread landscape layout';
      const zoomLabel = book?.isZoomed()
        ? `; zoom ${Math.round(book.zoomScale * 100)}%; page turning locked`
        : '';
      layoutStatus.textContent = layoutLabel + zoomLabel;
    }
    book?.pageLinks.sync();
    book?.positionControlDock();
  }

  function showReaderError(error) {
    console.error('[reader]', error);
    const status = document.getElementById('reader-page-status');
    const currentPage = document.getElementById('reader-current-page');
    const totalPages = document.getElementById('reader-total-pages');
    if (currentPage) currentPage.textContent = '!';
    if (totalPages) totalPages.textContent = '—';
    if (status) status.setAttribute('aria-label', 'Page loading failed');
  }

  function applyLayout(reason) {
    const shell = document.getElementById('reader-shell');
    const stage = document.getElementById('book-stage');
    const wrapper = document.getElementById('fullscreen-wrapper');
    if (!shell || !stage || !wrapper) return;
    const layout = desiredLayout();
    const viewport = viewportSize();
    const shellRotated = layout === 'portrait-rotated';
    const stageRotated = layout === 'portrait-stage-rotated';
    const changed = state.layout && state.layout !== layout;
    if (changed) shell.classList.add('is-transitioning');
    shell.style.width = `${Math.max(1, shellRotated ? viewport.height : viewport.width)}px`;
    shell.style.height = `${Math.max(1, shellRotated ? viewport.width : viewport.height)}px`;
    shell.dataset.layout = layout;
    stage.dataset.layout = layout;
    state.layout = layout;
    updateControls();

    function syncStageSize() {
      if (stageRotated) {
        stage.style.width = `${Math.max(1, wrapper.clientHeight)}px`;
        stage.style.height = `${Math.max(1, wrapper.clientWidth)}px`;
      } else {
        stage.style.width = '100%';
        stage.style.height = '100%';
      }
      state.book?.resize();
    }

    window.requestAnimationFrame(function () {
      syncStageSize();
      window.requestAnimationFrame(syncStageSize);
    });
    if (PERF_ENABLED) {
      console.info('[reader:layout]', JSON.stringify({ reason, layout, viewport }));
    }
  }

  function scheduleLayout(reason) {
    window.clearTimeout(state.resizeTimer);
    state.resizeTimer = window.setTimeout(function () { applyLayout(reason); }, 80);
  }

  function bindControls() {
    const previous = document.getElementById('reader-prev');
    const next = document.getElementById('reader-next');
    const edgePrevious = document.getElementById('reader-edge-prev');
    const edgeNext = document.getElementById('reader-edge-next');
    const zoomOut = document.getElementById('reader-zoom-out');
    const zoomIn = document.getElementById('reader-zoom-in');
    const pageMode = document.getElementById('reader-page-mode');
    const fullscreen = document.getElementById('reader-fullscreen');
    const enterFullscreenIcon = document.getElementById('reader-enter-fullscreen-icon');
    const exitFullscreenIcon = document.getElementById('reader-exit-fullscreen-icon');
    const shell = document.getElementById('reader-shell');
    [previous, next, edgePrevious, edgeNext, pageMode].forEach(function (control) {
      control?.addEventListener('pointerdown', function () {
        state.book?.pageLinks.interrupt();
      });
    });
    previous?.addEventListener('click', function () { state.book?.navigate(-1); });
    next?.addEventListener('click', function () { state.book?.navigate(1); });
    edgePrevious?.addEventListener('click', function () { state.book?.navigate(-1); });
    edgeNext?.addEventListener('click', function () { state.book?.navigate(1); });
    zoomOut?.addEventListener('click', function () { state.book?.zoomBy(-ZOOM_STEP); });
    zoomIn?.addEventListener('click', function () { state.book?.zoomBy(ZOOM_STEP); });
    pageMode?.addEventListener('click', function () { state.book?.togglePageMode(); });
    fullscreen?.addEventListener('click', async function () {
      if (document.fullscreenElement) await document.exitFullscreen?.();
      else await document.documentElement.requestFullscreen?.();
    });
    document.addEventListener('fullscreenchange', function () {
      const isFullscreen = Boolean(document.fullscreenElement);
      fullscreen?.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
      enterFullscreenIcon?.toggleAttribute('hidden', isFullscreen);
      exitFullscreenIcon?.toggleAttribute('hidden', !isFullscreen);
      scheduleLayout('fullscreen');
    });
    shell?.addEventListener('transitionend', function (event) {
      if (event.propertyName !== 'transform') return;
      shell.classList.remove('is-transitioning');
      state.book?.resize();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        state.book?.navigate(1);
        event.preventDefault();
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        state.book?.navigate(-1);
        event.preventDefault();
      } else if (event.key === 'Home') {
        state.book?.goToSpread(0);
        event.preventDefault();
      } else if (event.key === 'End') {
        state.book?.goToSpread(state.book.maxSpread);
        event.preventDefault();
      } else if (event.key === '+' || event.key === '=') {
        state.book?.zoomBy(ZOOM_STEP);
        event.preventDefault();
      } else if (event.key === '-') {
        state.book?.zoomBy(-ZOOM_STEP);
        event.preventDefault();
      } else if (event.key === '0' && state.book?.isZoomed()) {
        state.book?.setZoom(ZOOM_MINIMUM);
        event.preventDefault();
      }
    });

    let lastWheelAt = 0;
    document.getElementById('fullscreen-wrapper')?.addEventListener('wheel', function (event) {
      if (state.book?.profile.handheld || Math.abs(event.deltaY) < 18) return;
      const now = performance.now();
      if (now - lastWheelAt < 520) return;
      lastWheelAt = now;
      state.book?.navigate(event.deltaY > 0 ? 1 : -1);
      event.preventDefault();
    }, { passive: false });
  }

  function runStressTest() {
    if (!PERF_ENABLED) return;
    const count = clamp(Number(SEARCH_PARAMS.get('stress') || 0), 0, 25);
    if (!count) return;
    let remaining = count;
    const interval = Math.max(120, Number(SEARCH_PARAMS.get('stressInterval') || CONFIG.flipDuration + 80));
    const step = function () {
      if (!remaining || !state.book?.canNavigate(1)) return;
      state.book.navigate(1);
      remaining -= 1;
      state.stressTimer = window.setTimeout(step, interval);
    };
    state.stressTimer = window.setTimeout(step, 2600);
  }

  async function initializeReader() {
    const canvas = document.getElementById('book-canvas');
    const stage = document.getElementById('book-stage');
    if (!canvas || !stage) return;
    if (!window.THREE) {
      showReaderError(new Error('Three.js did not load'));
      return;
    }
    bindControls();
    applyLayout('startup');
    try {
      const book = new DannyFlipBook(canvas, PAGE_URLS);
      state.book = book;
      window.__dannyFlipBook = book;
      window.__dannyFlipReaderConfig = CONFIG;
      await book.initialize();
      const initialPage = clamp(Math.round(CONFIG.initialPage), 1, book.totalPages);
      if (initialPage > 1) {
        await book.goToSpread(Math.floor(initialPage / 2));
        if (book.pageMode === 'single' && book.activePage !== initialPage) {
          book.activePage = initialPage;
          book.bookGroup.position.x = book.centerForView(book.spread, initialPage);
          book.requestRender();
        }
      }
      stage.classList.add('is-ready');
      updateControls();
      runStressTest();
    } catch (error) {
      showReaderError(error);
    }
  }

  window.addEventListener('resize', function () { scheduleLayout('resize'); }, { passive: true });
  window.addEventListener('orientationchange', function () { scheduleLayout('orientationchange'); }, { passive: true });
  window.visualViewport?.addEventListener('resize', function () { scheduleLayout('visualViewport'); }, { passive: true });
  window.addEventListener('pagehide', function () {
    window.clearTimeout(state.stressTimer);
    state.book?.dispose();
  }, { once: true });
  document.addEventListener('DOMContentLoaded', function () {
    startIntroAnimation();
    initializeReader();
  }, { once: true });
})();
