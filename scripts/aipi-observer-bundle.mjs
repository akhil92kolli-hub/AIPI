import { createRequire as _aipiCreateRequire } from 'node:module'; const require = _aipiCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/ms/index.js
var require_ms = __commonJS({
  "node_modules/ms/index.js"(exports, module) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error(
        "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
      );
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
        str
      );
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    function fmtShort(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return Math.round(ms / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms / s) + "s";
      }
      return ms + "ms";
    }
    function fmtLong(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return plural(ms, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms, msAbs, s, "second");
      }
      return ms + " ms";
    }
    function plural(ms, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms / n) + " " + name + (isPlural ? "s" : "");
    }
  }
});

// node_modules/debug/src/common.js
var require_common = __commonJS({
  "node_modules/debug/src/common.js"(exports, module) {
    function setup(env2) {
      createDebug.debug = createDebug;
      createDebug.default = createDebug;
      createDebug.coerce = coerce;
      createDebug.disable = disable;
      createDebug.enable = enable;
      createDebug.enabled = enabled;
      createDebug.humanize = require_ms();
      createDebug.destroy = destroy;
      Object.keys(env2).forEach((key) => {
        createDebug[key] = env2[key];
      });
      createDebug.names = [];
      createDebug.skips = [];
      createDebug.formatters = {};
      function selectColor(namespace) {
        let hash = 0;
        for (let i = 0; i < namespace.length; i++) {
          hash = (hash << 5) - hash + namespace.charCodeAt(i);
          hash |= 0;
        }
        return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
      }
      createDebug.selectColor = selectColor;
      function createDebug(namespace) {
        let prevTime;
        let enableOverride = null;
        let namespacesCache;
        let enabledCache;
        function debug2(...args) {
          if (!debug2.enabled) {
            return;
          }
          const self = debug2;
          const curr = Number(/* @__PURE__ */ new Date());
          const ms = curr - (prevTime || curr);
          self.diff = ms;
          self.prev = prevTime;
          self.curr = curr;
          prevTime = curr;
          args[0] = createDebug.coerce(args[0]);
          if (typeof args[0] !== "string") {
            args.unshift("%O");
          }
          let index = 0;
          args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format2) => {
            if (match === "%%") {
              return "%";
            }
            index++;
            const formatter = createDebug.formatters[format2];
            if (typeof formatter === "function") {
              const val = args[index];
              match = formatter.call(self, val);
              args.splice(index, 1);
              index--;
            }
            return match;
          });
          createDebug.formatArgs.call(self, args);
          const logFn = self.log || createDebug.log;
          logFn.apply(self, args);
        }
        debug2.namespace = namespace;
        debug2.useColors = createDebug.useColors();
        debug2.color = createDebug.selectColor(namespace);
        debug2.extend = extend;
        debug2.destroy = createDebug.destroy;
        Object.defineProperty(debug2, "enabled", {
          enumerable: true,
          configurable: false,
          get: () => {
            if (enableOverride !== null) {
              return enableOverride;
            }
            if (namespacesCache !== createDebug.namespaces) {
              namespacesCache = createDebug.namespaces;
              enabledCache = createDebug.enabled(namespace);
            }
            return enabledCache;
          },
          set: (v) => {
            enableOverride = v;
          }
        });
        if (typeof createDebug.init === "function") {
          createDebug.init(debug2);
        }
        return debug2;
      }
      function extend(namespace, delimiter) {
        const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
        newDebug.log = this.log;
        return newDebug;
      }
      function enable(namespaces) {
        createDebug.save(namespaces);
        createDebug.namespaces = namespaces;
        createDebug.names = [];
        createDebug.skips = [];
        const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
        for (const ns of split) {
          if (ns[0] === "-") {
            createDebug.skips.push(ns.slice(1));
          } else {
            createDebug.names.push(ns);
          }
        }
      }
      function matchesTemplate(search, template) {
        let searchIndex = 0;
        let templateIndex = 0;
        let starIndex = -1;
        let matchIndex = 0;
        while (searchIndex < search.length) {
          if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
            if (template[templateIndex] === "*") {
              starIndex = templateIndex;
              matchIndex = searchIndex;
              templateIndex++;
            } else {
              searchIndex++;
              templateIndex++;
            }
          } else if (starIndex !== -1) {
            templateIndex = starIndex + 1;
            matchIndex++;
            searchIndex = matchIndex;
          } else {
            return false;
          }
        }
        while (templateIndex < template.length && template[templateIndex] === "*") {
          templateIndex++;
        }
        return templateIndex === template.length;
      }
      function disable() {
        const namespaces = [
          ...createDebug.names,
          ...createDebug.skips.map((namespace) => "-" + namespace)
        ].join(",");
        createDebug.enable("");
        return namespaces;
      }
      function enabled(name) {
        for (const skip of createDebug.skips) {
          if (matchesTemplate(name, skip)) {
            return false;
          }
        }
        for (const ns of createDebug.names) {
          if (matchesTemplate(name, ns)) {
            return true;
          }
        }
        return false;
      }
      function coerce(val) {
        if (val instanceof Error) {
          return val.stack || val.message;
        }
        return val;
      }
      function destroy() {
        console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
      }
      createDebug.enable(createDebug.load());
      return createDebug;
    }
    module.exports = setup;
  }
});

// node_modules/debug/src/browser.js
var require_browser = __commonJS({
  "node_modules/debug/src/browser.js"(exports, module) {
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.storage = localstorage();
    exports.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports.storage.setItem("debug", namespaces);
        } else {
          exports.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      let r;
      try {
        r = exports.storage.getItem("debug") || exports.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module.exports = require_common()(exports);
    var { formatters } = module.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  }
});

// node_modules/supports-color/index.js
var supports_color_exports = {};
__export(supports_color_exports, {
  createSupportsColor: () => createSupportsColor,
  default: () => supports_color_default
});
import process2 from "node:process";
import os from "node:os";
import tty from "node:tty";
function hasFlag(flag, argv = globalThis.Deno ? globalThis.Deno.args : process2.argv) {
  const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
  const position = argv.indexOf(prefix + flag);
  const terminatorPosition = argv.indexOf("--");
  return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
}
function envForceColor() {
  if (!("FORCE_COLOR" in env)) {
    return;
  }
  if (env.FORCE_COLOR === "true") {
    return 1;
  }
  if (env.FORCE_COLOR === "false") {
    return 0;
  }
  if (env.FORCE_COLOR.length === 0) {
    return 1;
  }
  const level = Math.min(Number.parseInt(env.FORCE_COLOR, 10), 3);
  if (![0, 1, 2, 3].includes(level)) {
    return;
  }
  return level;
}
function translateLevel(level) {
  if (level === 0) {
    return false;
  }
  return {
    level,
    hasBasic: true,
    has256: level >= 2,
    has16m: level >= 3
  };
}
function _supportsColor(haveStream, { streamIsTTY, sniffFlags = true } = {}) {
  const noFlagForceColor = envForceColor();
  if (noFlagForceColor !== void 0) {
    flagForceColor = noFlagForceColor;
  }
  const forceColor = sniffFlags ? flagForceColor : noFlagForceColor;
  if (forceColor === 0) {
    return 0;
  }
  if (sniffFlags) {
    if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) {
      return 3;
    }
    if (hasFlag("color=256")) {
      return 2;
    }
  }
  if ("TF_BUILD" in env && "AGENT_NAME" in env) {
    return 1;
  }
  if (haveStream && !streamIsTTY && forceColor === void 0) {
    return 0;
  }
  const min = forceColor || 0;
  if (env.TERM === "dumb") {
    return min;
  }
  if (process2.platform === "win32") {
    const osRelease = os.release().split(".");
    if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
      return Number(osRelease[2]) >= 14931 ? 3 : 2;
    }
    return 1;
  }
  if ("CI" in env) {
    if (["GITHUB_ACTIONS", "GITEA_ACTIONS", "CIRCLECI"].some((key) => key in env)) {
      return 3;
    }
    if (["TRAVIS", "APPVEYOR", "GITLAB_CI", "BUILDKITE", "DRONE"].some((sign) => sign in env) || env.CI_NAME === "codeship") {
      return 1;
    }
    return min;
  }
  if ("TEAMCITY_VERSION" in env) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
  }
  if (env.COLORTERM === "truecolor") {
    return 3;
  }
  if (env.TERM === "xterm-kitty") {
    return 3;
  }
  if (env.TERM === "xterm-ghostty") {
    return 3;
  }
  if (env.TERM === "wezterm") {
    return 3;
  }
  if ("TERM_PROGRAM" in env) {
    const version = Number.parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
    switch (env.TERM_PROGRAM) {
      case "iTerm.app": {
        return version >= 3 ? 3 : 2;
      }
      case "Apple_Terminal": {
        return 2;
      }
    }
  }
  if (/-256(color)?$/i.test(env.TERM)) {
    return 2;
  }
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
    return 1;
  }
  if ("COLORTERM" in env) {
    return 1;
  }
  return min;
}
function createSupportsColor(stream, options = {}) {
  const level = _supportsColor(stream, {
    streamIsTTY: stream && stream.isTTY,
    ...options
  });
  return translateLevel(level);
}
var env, flagForceColor, supportsColor, supports_color_default;
var init_supports_color = __esm({
  "node_modules/supports-color/index.js"() {
    ({ env } = process2);
    if (hasFlag("no-color") || hasFlag("no-colors") || hasFlag("color=false") || hasFlag("color=never")) {
      flagForceColor = 0;
    } else if (hasFlag("color") || hasFlag("colors") || hasFlag("color=true") || hasFlag("color=always")) {
      flagForceColor = 1;
    }
    supportsColor = {
      stdout: createSupportsColor({ isTTY: tty.isatty(1) }),
      stderr: createSupportsColor({ isTTY: tty.isatty(2) })
    };
    supports_color_default = supportsColor;
  }
});

// node_modules/debug/src/node.js
var require_node = __commonJS({
  "node_modules/debug/src/node.js"(exports, module) {
    var tty2 = __require("tty");
    var util = __require("util");
    exports.init = init;
    exports.log = log;
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.destroy = util.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor2 = (init_supports_color(), __toCommonJS(supports_color_exports));
      if (supportsColor2 && (supportsColor2.stderr || supportsColor2).level >= 2) {
        exports.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error) {
    }
    exports.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports.inspectOpts ? Boolean(exports.inspectOpts.colors) : tty2.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log(...args) {
      return process.stderr.write(util.formatWithOptions(exports.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug2) {
      debug2.inspectOpts = {};
      const keys = Object.keys(exports.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug2.inspectOpts[keys[i]] = exports.inspectOpts[keys[i]];
      }
    }
    module.exports = require_common()(exports);
    var { formatters } = module.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
  }
});

// node_modules/debug/src/index.js
var require_src = __commonJS({
  "node_modules/debug/src/index.js"(exports, module) {
    if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
      module.exports = require_browser();
    } else {
      module.exports = require_node();
    }
  }
});

// node_modules/rettime/build/lens-list.mjs
var LensList = class {
  #list;
  #lens;
  constructor() {
    this.#list = [];
    this.#lens = /* @__PURE__ */ new Map();
  }
  get [Symbol.iterator]() {
    return this.#list[Symbol.iterator].bind(this.#list);
  }
  entries() {
    return this.#lens.entries();
  }
  /**
  * Return an order-sensitive list of values by the given key.
  */
  get(key) {
    return this.#lens.get(key) || [];
  }
  /**
  * Return an order-sensitive list of all values.
  */
  getAll() {
    return this.#list.map(([, value]) => value);
  }
  /**
  * Append a new value to the given key.
  */
  append(key, value) {
    this.#list.push([key, value]);
    this.#openLens(key, (list) => list.push(value));
  }
  /**
  * Prepend a new value to the given key.
  */
  prepend(key, value) {
    this.#list.unshift([key, value]);
    this.#openLens(key, (list) => list.unshift(value));
  }
  /**
  * Delete the value belonging to the given key.
  * Returns `true` if the value was present and removed, `false` otherwise.
  */
  delete(key, value) {
    if (this.size === 0) return false;
    const values = this.#lens.get(key);
    if (!values) return false;
    const index = values.indexOf(value);
    if (index === -1) return false;
    values.splice(index, 1);
    this.#list.splice(this.#list.findIndex((item) => item[0] === key && item[1] === value), 1);
    return true;
  }
  /**
  * Delete all values belogning to the given key.
  */
  deleteAll(key) {
    if (this.size === 0) return;
    this.#list = this.#list.filter((item) => item[0] !== key);
    this.#lens.delete(key);
  }
  get size() {
    return this.#list.length;
  }
  clear() {
    if (this.size === 0) return;
    this.#list.length = 0;
    this.#lens.clear();
  }
  #openLens(key, setter) {
    setter(this.#lens.get(key) || this.#lens.set(key, []).get(key));
  }
};

// node_modules/rettime/build/index.mjs
var kDefaultPrevented = /* @__PURE__ */ Symbol("kDefaultPrevented");
var kPropagationStopped = /* @__PURE__ */ Symbol("kPropagationStopped");
var kImmediatePropagationStopped = /* @__PURE__ */ Symbol("kImmediatePropagationStopped");
var TypedEvent = class extends MessageEvent {
  /**
  * @note Keep a placeholder property with the return type
  * because the type must be set somewhere in order to be
  * correctly associated and inferred from the event.
  */
  #returnType;
  [kDefaultPrevented];
  [kPropagationStopped];
  [kImmediatePropagationStopped];
  constructor(...args) {
    super(args[0], args[1]);
    this[kDefaultPrevented] = false;
  }
  get defaultPrevented() {
    return this[kDefaultPrevented];
  }
  preventDefault() {
    super.preventDefault();
    this[kDefaultPrevented] = true;
  }
  stopImmediatePropagation() {
    super.stopImmediatePropagation();
    this[kImmediatePropagationStopped] = true;
  }
};
var Emitter = class {
  #listeners;
  #listenerOptions;
  #listenerAbortCleanups;
  #typelessListeners;
  #hookListeners;
  #hookListenerOptions;
  #hookListenerAbortCleanups;
  hooks;
  constructor() {
    this.#listeners = new LensList();
    this.#listenerOptions = /* @__PURE__ */ new WeakMap();
    this.#listenerAbortCleanups = /* @__PURE__ */ new WeakMap();
    this.#typelessListeners = /* @__PURE__ */ new WeakSet();
    this.#hookListeners = new LensList();
    this.#hookListenerOptions = /* @__PURE__ */ new WeakMap();
    this.#hookListenerAbortCleanups = /* @__PURE__ */ new WeakMap();
    this.hooks = {
      on: (hook, callback, options) => {
        if (options?.signal?.aborted) return;
        if (options?.once) {
          const original = callback;
          const wrapper = ((...args) => {
            this.#deleteHookListener(hook, wrapper);
            return original(...args);
          });
          callback = wrapper;
        }
        this.#hookListeners.append(hook, callback);
        if (options) this.#hookListenerOptions.set(callback, options);
        if (options?.signal) {
          const { signal } = options;
          const onAbort = () => {
            this.#deleteHookListener(hook, callback);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          this.#hookListenerAbortCleanups.set(callback, () => {
            signal.removeEventListener("abort", onAbort);
          });
        }
      },
      removeListener: (hook, callback) => {
        this.#deleteHookListener(hook, callback);
      }
    };
  }
  #deleteHookListener(hook, callback) {
    this.#hookListeners.delete(hook, callback);
    const cleanup = this.#hookListenerAbortCleanups.get(callback);
    if (cleanup) {
      cleanup();
      this.#hookListenerAbortCleanups.delete(callback);
    }
  }
  #deleteListener(type, listener) {
    const removed = this.#listeners.delete(type, listener);
    const cleanup = this.#listenerAbortCleanups.get(listener);
    if (cleanup) {
      cleanup();
      this.#listenerAbortCleanups.delete(listener);
    }
    return removed;
  }
  /**
  * Adds a listener for the given event type.
  */
  on(type, listener, options) {
    this.#addListener(type, listener, options);
    return this;
  }
  /**
  * Adds a one-time listener for the given event type.
  */
  once(type, listener, options) {
    return this.on(type, listener, {
      ...options || {},
      once: true
    });
  }
  /**
  * Prepends a listener for the given event type.
  */
  earlyOn(type, listener, options) {
    this.#addListener(type, listener, options, "prepend");
    return this;
  }
  /**
  * Prepends a one-time listener for the given event type.
  */
  earlyOnce(type, listener, options) {
    return this.earlyOn(type, listener, {
      ...options || {},
      once: true
    });
  }
  /**
  * Emits the given typed event.
  *
  * @returns {boolean} Returns `true` if the event had any listeners, `false` otherwise.
  */
  emit(event) {
    if (this.#listeners.size === 0) return false;
    const hasListeners = this.listenerCount(event.type) > 0;
    const proxiedEvent = this.#proxyEvent(event);
    for (const listener of this.#matchListeners(event.type)) {
      if (proxiedEvent.event[kPropagationStopped] != null && proxiedEvent.event[kPropagationStopped] !== this) {
        proxiedEvent.revoke();
        return false;
      }
      if (proxiedEvent.event[kImmediatePropagationStopped]) break;
      this.#callListener(proxiedEvent.event, listener);
    }
    proxiedEvent.revoke();
    return hasListeners;
  }
  /**
  * Emits the given typed event and returns a promise that resolves
  * when all the listeners for that event have settled.
  *
  * @returns {Promise<Array<Emitter.ListenerReturnType>>} A promise that resolves
  * with the return values of all listeners.
  */
  async emitAsPromise(event) {
    if (this.#listeners.size === 0) return [];
    const pendingListeners = [];
    const proxiedEvent = this.#proxyEvent(event);
    for (const listener of this.#matchListeners(event.type)) {
      if (proxiedEvent.event[kPropagationStopped] != null && proxiedEvent.event[kPropagationStopped] !== this) {
        proxiedEvent.revoke();
        return [];
      }
      if (proxiedEvent.event[kImmediatePropagationStopped]) break;
      const returnValue = await Promise.resolve(this.#callListener(proxiedEvent.event, listener));
      if (!this.#isTypelessListener(listener)) pendingListeners.push(returnValue);
    }
    proxiedEvent.revoke();
    return Promise.allSettled(pendingListeners).then((results) => {
      return results.map((result) => result.status === "fulfilled" ? result.value : result.reason);
    });
  }
  /**
  * Emits the given event and returns a generator that yields
  * the result of each listener in the order of their registration.
  * This way, you stop exhausting the listeners once you get the expected value.
  */
  *emitAsGenerator(event) {
    if (this.#listeners.size === 0) return;
    const proxiedEvent = this.#proxyEvent(event);
    for (const listener of this.#matchListeners(event.type)) {
      if (proxiedEvent.event[kPropagationStopped] != null && proxiedEvent.event[kPropagationStopped] !== this) {
        proxiedEvent.revoke();
        return;
      }
      if (proxiedEvent.event[kImmediatePropagationStopped]) break;
      const returnValue = this.#callListener(proxiedEvent.event, listener);
      if (!this.#isTypelessListener(listener)) yield returnValue;
    }
    proxiedEvent.revoke();
  }
  /**
  * Removes a listener for the given event type.
  */
  removeListener(type, listener) {
    const options = this.#listenerOptions.get(listener);
    if (!this.#deleteListener(type, listener)) return;
    for (const hook of this.#hookListeners.get("removeListener").slice()) hook(type, listener, options);
  }
  /**
  * Removes all listeners for the given event type.
  * If no event type is provided, removes all existing listeners.
  */
  removeAllListeners(type) {
    if (type == null) {
      for (const [listenerType, listeners$1] of this.#listeners.entries()) while (listeners$1.length > 0) this.removeListener(listenerType, listeners$1[0]);
      for (const [hookType, hookListener] of [...this.#hookListeners]) if (!this.#hookListenerOptions.get(hookListener)?.persist) this.#deleteHookListener(hookType, hookListener);
      return;
    }
    const listeners = this.listeners(type);
    while (listeners.length > 0) this.removeListener(type, listeners[0]);
  }
  /**
  * Returns the list of listeners for the given event type.
  * If no even type is provided, returns all listeners.
  */
  listeners(type) {
    if (type == null) return this.#listeners.getAll();
    return this.#listeners.get(type);
  }
  /**
  * Returns the number of listeners for the given event type.
  * If no even type is provided, returns the total number of listeners.
  */
  listenerCount(type) {
    if (type == null) return this.#listeners.size;
    return this.listeners(type).length;
  }
  #addListener(type, listener, options, insertMode = "append") {
    if (options?.signal?.aborted) return;
    for (const hook of this.#hookListeners.get("newListener").slice()) hook(type, listener, options);
    if (type === "*") this.#typelessListeners.add(listener);
    if (insertMode === "prepend") this.#listeners.prepend(type, listener);
    else this.#listeners.append(type, listener);
    if (options) {
      this.#listenerOptions.set(listener, options);
      if (options.signal) {
        const { signal } = options;
        const onAbort = () => {
          this.removeListener(type, listener);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.#listenerAbortCleanups.set(listener, () => {
          signal.removeEventListener("abort", onAbort);
        });
      }
    }
  }
  #proxyEvent(event) {
    const { stopPropagation } = event;
    event.stopPropagation = () => {
      event[kPropagationStopped] = this;
      stopPropagation.call(event);
    };
    return {
      event,
      revoke() {
        event.stopPropagation = stopPropagation;
      }
    };
  }
  #callListener(event, listener) {
    for (const hook of this.#hookListeners.get("beforeEmit").slice()) if (hook(event) === false) return;
    const returnValue = listener.call(this, event);
    const options = this.#listenerOptions.get(listener);
    if (options?.once) {
      const type = this.#isTypelessListener(listener) ? "*" : event.type;
      if (this.#deleteListener(type, listener)) for (const hook of this.#hookListeners.get("removeListener").slice()) hook(type, listener, options);
    }
    return returnValue;
  }
  /**
  * Return a list of all event listeners relevant for the given event type.
  * This includes the explicit event listeners and also typeless event listeners.
  *
  * @note Snapshot the matching listeners before yielding. Listeners can add or
  * remove other listeners during emission (e.g. `earlyOn` unshifts `#list`),
  * which would otherwise shift the live iterator and re-yield prior entries.
  */
  *#matchListeners(type) {
    const snapshot = [];
    for (const [key, listener] of this.#listeners) if (key === "*" || key === type) snapshot.push(listener);
    yield* snapshot;
  }
  #isTypelessListener(listener) {
    return this.#typelessListeners.has(listener);
  }
};

// node_modules/@mswjs/interceptors/lib/node/interceptor-C8qRPjxG.js
var import_debug = __toESM(require_src(), 1);
var Disposable = class {
  constructor() {
    this.subscriptions = [];
  }
  dispose() {
    let subscription;
    while (subscription = this.subscriptions.pop()) subscription();
  }
};
var LOG_TIMESTAMP_REGEXP = /\d{2}:\d{2}:\d{2}\.\d{3}/;
function normalizeNamespace(namespace) {
  return namespace.split(":").map((segment) => {
    return segment.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  }).filter(Boolean).join(":");
}
function getTimestamp() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
}
async function readBody(message) {
  if (message.body == null) return null;
  try {
    return await message.clone().text();
  } catch {
    return null;
  }
}
function formatHeaders(headers) {
  return Array.from(headers.entries()).map(([name, value]) => {
    return `${name}: ${value}`;
  });
}
async function formatHttpMessage(startLine, message) {
  const lines = [startLine, ...formatHeaders(message.headers)];
  const body = await readBody(message);
  lines.push("", body ?? "");
  return lines.join("\n");
}
async function formatRequest(request) {
  return formatHttpMessage(`${request.method} ${request.url}`, request);
}
async function formatResponse(response) {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return formatHttpMessage(`HTTP ${response.status}${statusText}`, response);
}
function formatLogArguments(arguments_) {
  const message = arguments_[0];
  if (typeof message === "string") {
    const messageWithoutDebugTimestamp = message.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, "");
    const timestampMatch = messageWithoutDebugTimestamp.match(LOG_TIMESTAMP_REGEXP);
    if (!timestampMatch || timestampMatch.index === void 0) {
      arguments_[0] = messageWithoutDebugTimestamp;
      return;
    }
    const messagePrefix = messageWithoutDebugTimestamp.slice(0, timestampMatch.index).trim();
    const messageBody = messageWithoutDebugTimestamp.slice(timestampMatch.index + timestampMatch[0].length).trimStart();
    arguments_[0] = `${timestampMatch[0]} ${messagePrefix} ${messageBody}`;
  }
}
function useConciseTimestamp(logger3) {
  logger3.log = (...arguments_) => {
    formatLogArguments(arguments_);
    import_debug.default.log(...arguments_);
  };
}
function isVerboseLoggingEnabled() {
  if (typeof process !== "undefined" && process.env.DEBUG_LEVEL === "verbose") return true;
  if (typeof document === "undefined") return false;
  try {
    return globalThis.localStorage?.getItem("debugLevel") === "verbose";
  } catch {
    return false;
  }
}
function createLogger(namespace) {
  const logger3 = (0, import_debug.default)(`interceptors:${normalizeNamespace(namespace)}`);
  Reflect.set(logger3, "useColors", true);
  useConciseTimestamp(logger3);
  return {
    info(message, ...positionals) {
      logger3(`${getTimestamp()} ${message}`, ...positionals);
    },
    verbose(message, ...positionals) {
      if (!isVerboseLoggingEnabled()) return;
      logger3(`${getTimestamp()} ${message}`, ...positionals);
    },
    isEnabled(level) {
      return logger3.enabled && (level === "default" || isVerboseLoggingEnabled());
    }
  };
}
var interceptorsRegistry = globalThis.__MSW_INTERCEPTORS_REGISTRY ??= /* @__PURE__ */ new Map();
var Interceptor = class extends Disposable {
  #owners;
  static singleton(InterceptorClass) {
    const symbol = InterceptorClass.symbol;
    const existing = interceptorsRegistry.get(symbol);
    if (existing instanceof InterceptorClass) return existing;
    const newInstance = new InterceptorClass();
    interceptorsRegistry.set(symbol, newInstance);
    return newInstance;
  }
  constructor() {
    super();
    this.on = (type, listener, options) => {
      return this.emitter.on(type, listener, options);
    };
    this.once = (type, listener, options) => {
      return this.emitter.once(type, listener, options);
    };
    this.listeners = (type) => {
      return this.emitter.listeners(type);
    };
    this.listenerCount = (type) => {
      return this.emitter.listenerCount(type);
    };
    this.removeListener = (type, listener) => {
      return this.emitter.removeListener(type, listener);
    };
    this.removeAllListeners = (type) => {
      this.logger.info("removeAllListeners %o", { eventType: type ?? "*" });
      return this.emitter.removeAllListeners(type);
    };
    this.#owners = /* @__PURE__ */ new Set();
    this.readyState = "INACTIVE";
    this.emitter = new Emitter();
    this.logger = createLogger(this.#getLoggerNamespace());
  }
  apply(owner = this) {
    if (this.#owners.has(owner)) return;
    if (this.readyState !== "ACTIVE" && !this.predicate()) return;
    this.#owners.add(owner);
    if (this.readyState === "ACTIVE") return;
    try {
      this.setup();
      this.readyState = "ACTIVE";
      this.logger.info("apply");
    } catch (error) {
      this.dispose(owner);
      throw error;
    }
  }
  dispose(owner = this) {
    if (!this.#owners.delete(owner)) return;
    if (this.#owners.size > 0) return;
    super.dispose();
    this.emitter.removeAllListeners();
    this.readyState = "DISPOSED";
    this.logger.info("disable");
  }
  #getLoggerNamespace() {
    const symbolDescription = this.constructor.symbol?.description;
    if (symbolDescription) return symbolDescription.replace(/-interceptor$/, "");
    return this.constructor.name.replace(/Interceptor$/, "");
  }
};

// node_modules/outvariant/lib/index.mjs
var POSITIONALS_EXP = /(%?)(%([sdijo]))/g;
function serializePositional(positional, flag) {
  switch (flag) {
    case "s":
      return positional;
    case "d":
    case "i":
      return Number(positional);
    case "j":
      return JSON.stringify(positional);
    case "o": {
      if (typeof positional === "string") {
        return positional;
      }
      const json = JSON.stringify(positional);
      if (json === "{}" || json === "[]" || /^\[object .+?\]$/.test(json)) {
        return positional;
      }
      return json;
    }
  }
}
function format(message, ...positionals) {
  if (positionals.length === 0) {
    return message;
  }
  let positionalIndex = 0;
  let formattedMessage = message.replace(
    POSITIONALS_EXP,
    (match, isEscaped, _, flag) => {
      const positional = positionals[positionalIndex];
      const value = serializePositional(positional, flag);
      if (!isEscaped) {
        positionalIndex++;
        return value;
      }
      return match;
    }
  );
  if (positionalIndex < positionals.length) {
    formattedMessage += ` ${positionals.slice(positionalIndex).join(" ")}`;
  }
  formattedMessage = formattedMessage.replace(/%{2,2}/g, "%");
  return formattedMessage;
}
var STACK_FRAMES_TO_IGNORE = 2;
function cleanErrorStack(error) {
  if (!error.stack) {
    return;
  }
  const nextStack = error.stack.split("\n");
  nextStack.splice(1, STACK_FRAMES_TO_IGNORE);
  error.stack = nextStack.join("\n");
}
var InvariantError = class extends Error {
  constructor(message, ...positionals) {
    super(message);
    this.message = message;
    this.name = "Invariant Violation";
    this.message = format(message, ...positionals);
    cleanErrorStack(this);
  }
};
var invariant = (predicate, message, ...positionals) => {
  if (!predicate) {
    throw new InvariantError(message, ...positionals);
  }
};
invariant.as = (ErrorConstructor, predicate, message, ...positionals) => {
  if (!predicate) {
    const formatMessage = positionals.length === 0 ? message : format(message, ...positionals);
    let error;
    try {
      error = Reflect.construct(ErrorConstructor, [
        formatMessage
      ]);
    } catch (err) {
      error = ErrorConstructor(formatMessage);
    }
    throw error;
  }
};

// node_modules/@mswjs/interceptors/lib/node/fetch-utils-D-_xeRlK.js
var InterceptorError = class InterceptorError2 extends Error {
  constructor(message) {
    super(message);
    this.name = "InterceptorError";
    Object.setPrototypeOf(this, InterceptorError2.prototype);
  }
};
var RequestController = class RequestController2 {
  static {
    this.PENDING = 0;
  }
  static {
    this.PASSTHROUGH = 1;
  }
  static {
    this.RESPONSE = 2;
  }
  static {
    this.ERROR = 3;
  }
  #handled;
  constructor(request, source, options) {
    this.request = request;
    this.source = source;
    this.options = options;
    this.readyState = RequestController2.PENDING;
    this.#handled = Promise.withResolvers();
    this.handled = this.#handled.promise;
  }
  /**
  * Perform this request as-is.
  */
  async passthrough() {
    invariant.as(InterceptorError, this.readyState === RequestController2.PENDING, 'Failed to passthrough the "%s %s" request: the request has already been handled', this.request.method, this.request.url);
    this.readyState = RequestController2.PASSTHROUGH;
    if (this.options) this.options.logger.info("[%s] passthrough", this.options.requestId);
    await this.source.passthrough();
    this.#handled.resolve();
  }
  /**
  * Respond to this request with the given `Response` instance.
  *
  * @example
  * controller.respondWith(new Response())
  * controller.respondWith(Response.json({ id }))
  * controller.respondWith(Response.error())
  */
  respondWith(response) {
    invariant.as(InterceptorError, this.readyState === RequestController2.PENDING, 'Failed to respond to the "%s %s" request with "%d %s": the request has already been handled (%d)', this.request.method, this.request.url, response.status, response.statusText || "OK", this.readyState);
    this.readyState = RequestController2.RESPONSE;
    if (this.options?.logger.isEnabled("default")) {
      const { logger: logger3, requestId } = this.options;
      formatResponse(response).then((message) => {
        logger3.info("[%s] mocked %s", requestId, message);
      });
    }
    this.#handled.resolve();
    this.source.respondWith(response);
  }
  /**
  * Error this request with the given reason.
  *
  * @example
  * controller.errorWith()
  * controller.errorWith(new Error('Oops!'))
  * controller.errorWith({ message: 'Oops!'})
  */
  errorWith(reason) {
    invariant.as(InterceptorError, this.readyState === RequestController2.PENDING, 'Failed to error the "%s %s" request with "%s": the request has already been handled (%d)', this.request.method, this.request.url, reason?.toString(), this.readyState);
    this.readyState = RequestController2.ERROR;
    if (this.options) this.options.logger.info("[%s] error %o", this.options.requestId, reason);
    this.source.errorWith(reason);
    this.#handled.resolve();
  }
};
var kRawHeaders = /* @__PURE__ */ Symbol("kRawHeaders");
var kRestorePatches = /* @__PURE__ */ Symbol("kRestorePatches");
function recordRawHeader(headers, args, behavior) {
  ensureRawHeadersSymbol(headers, []);
  const rawHeaders = Reflect.get(headers, kRawHeaders);
  if (behavior === "set") {
    for (let index = rawHeaders.length - 1; index >= 0; index--) if (rawHeaders[index][0].toLowerCase() === args[0].toLowerCase()) rawHeaders.splice(index, 1);
  }
  rawHeaders.push(args);
}
function ensureRawHeadersSymbol(headers, rawHeaders) {
  if (Reflect.has(headers, kRawHeaders)) return;
  defineRawHeadersSymbol(headers, rawHeaders);
}
function defineRawHeadersSymbol(headers, rawHeaders) {
  Object.defineProperty(headers, kRawHeaders, {
    value: rawHeaders,
    enumerable: false,
    configurable: true
  });
}
function recordRawFetchHeaders() {
  if (Reflect.get(Headers, kRestorePatches)) return Reflect.get(Headers, kRestorePatches);
  const { Headers: OriginalHeaders, Request: OriginalRequest, Response: OriginalResponse } = globalThis;
  const { set, append, delete: headersDeleteMethod } = Headers.prototype;
  Object.defineProperty(Headers, kRestorePatches, {
    value: () => {
      Headers.prototype.set = set;
      Headers.prototype.append = append;
      Headers.prototype.delete = headersDeleteMethod;
      globalThis.Headers = OriginalHeaders;
      globalThis.Request = OriginalRequest;
      globalThis.Response = OriginalResponse;
      Object.setPrototypeOf(FetchRequest, OriginalRequest);
      Object.setPrototypeOf(FetchRequest.prototype, OriginalRequest.prototype);
      Object.setPrototypeOf(FetchResponse, OriginalResponse);
      Object.setPrototypeOf(FetchResponse.prototype, OriginalResponse.prototype);
      Reflect.deleteProperty(Headers, kRestorePatches);
    },
    enumerable: false,
    /**
    * @note Mark this property as configurable
    * so we can delete it using `Reflect.delete` during cleanup.
    */
    configurable: true
  });
  Object.defineProperty(globalThis, "Headers", {
    enumerable: true,
    writable: true,
    value: new Proxy(Headers, { construct(target, args, newTarget) {
      const headersInit = args[0] || [];
      if (headersInit instanceof Headers && Reflect.has(headersInit, kRawHeaders)) {
        const sanitizedHeaders = Reflect.get(headersInit, kRawHeaders).map((tuple) => [tuple[0], tuple[1]]);
        const headers2 = Reflect.construct(target, [sanitizedHeaders], newTarget);
        ensureRawHeadersSymbol(headers2, [...sanitizedHeaders]);
        return headers2;
      }
      const headers = Reflect.construct(target, args, newTarget);
      if (!Reflect.has(headers, kRawHeaders)) ensureRawHeadersSymbol(headers, Array.isArray(headersInit) ? headersInit : Object.entries(headersInit));
      return headers;
    } })
  });
  Headers.prototype.set = new Proxy(Headers.prototype.set, { apply(target, thisArg, args) {
    recordRawHeader(thisArg, [args[0], args[1]], "set");
    return Reflect.apply(target, thisArg, args);
  } });
  Headers.prototype.append = new Proxy(Headers.prototype.append, { apply(target, thisArg, args) {
    recordRawHeader(thisArg, [args[0], args[1]], "append");
    return Reflect.apply(target, thisArg, args);
  } });
  Headers.prototype.delete = new Proxy(Headers.prototype.delete, { apply(target, thisArg, args) {
    const rawHeaders = Reflect.get(thisArg, kRawHeaders);
    if (rawHeaders) {
      for (let index = rawHeaders.length - 1; index >= 0; index--) if (rawHeaders[index][0].toLowerCase() === args[0].toLowerCase()) rawHeaders.splice(index, 1);
    }
    return Reflect.apply(target, thisArg, args);
  } });
  Object.defineProperty(globalThis, "Request", {
    enumerable: true,
    writable: true,
    value: new Proxy(Request, { construct(target, args, newTarget) {
      const request = Reflect.construct(target, args, newTarget);
      const inferredRawHeaders = [];
      if (typeof args[0] === "object" && args[0].headers != null) inferredRawHeaders.push(...inferRawHeaders(args[0].headers));
      if (typeof args[1] === "object" && args[1].headers != null) inferredRawHeaders.push(...inferRawHeaders(args[1].headers));
      if (inferredRawHeaders.length > 0) ensureRawHeadersSymbol(request.headers, inferredRawHeaders);
      return request;
    } })
  });
  Object.defineProperty(globalThis, "Response", {
    enumerable: true,
    writable: true,
    value: new Proxy(Response, { construct(target, args, newTarget) {
      const response = Reflect.construct(target, args, newTarget);
      if (typeof args[1] === "object" && args[1].headers != null) ensureRawHeadersSymbol(response.headers, inferRawHeaders(args[1].headers));
      return response;
    } })
  });
  Object.setPrototypeOf(FetchRequest, globalThis.Request);
  Object.setPrototypeOf(FetchRequest.prototype, globalThis.Request.prototype);
  Object.setPrototypeOf(FetchResponse, globalThis.Response);
  Object.setPrototypeOf(FetchResponse.prototype, globalThis.Response.prototype);
  return restoreHeadersPrototype;
}
function restoreHeadersPrototype() {
  if (!Reflect.get(Headers, kRestorePatches)) return;
  Reflect.get(Headers, kRestorePatches)();
}
function getRawFetchHeaders(headers) {
  if (!Reflect.has(headers, kRawHeaders)) return Array.from(headers.entries());
  const rawHeaders = Reflect.get(headers, kRawHeaders);
  return rawHeaders.length > 0 ? rawHeaders : Array.from(headers.entries());
}
function inferRawHeaders(headers) {
  if (headers instanceof Headers) return Reflect.get(headers, kRawHeaders) || [];
  return Reflect.get(new Headers(headers), kRawHeaders);
}
function copyRawHeaders(source, destination) {
  const rawHeaders = [...getRawFetchHeaders(source)];
  if (rawHeaders.length === 0) return;
  for (const [name, value] of destination) if (rawHeaders.every((header) => header[0].toLowerCase() !== name.toLowerCase())) rawHeaders.push([name, value]);
  defineRawHeadersSymbol(destination, rawHeaders);
}
function getValueBySymbol(symbolName, source) {
  const symbol = Object.getOwnPropertySymbols(source).find((symbol2) => {
    return symbol2.description === symbolName;
  });
  if (symbol) return Reflect.get(source, symbol);
}
function isObject(value, loose = false) {
  return loose ? Object.prototype.toString.call(value).startsWith("[object ") : Object.prototype.toString.call(value) === "[object Object]";
}
function isPropertyAccessible(obj, key) {
  try {
    obj[key];
    return true;
  } catch {
    return false;
  }
}
function createServerErrorResponse(body) {
  return new Response(JSON.stringify(body instanceof Error ? {
    name: body.name,
    message: body.message,
    stack: body.stack
  } : body), {
    status: 500,
    statusText: "Unhandled Exception",
    headers: { "Content-Type": "application/json" }
  });
}
var kErrorResponse = /* @__PURE__ */ Symbol("kErrorResponse");
function isResponseError(response) {
  return response != null && response instanceof Response && isPropertyAccessible(response, "type") && response.type === "error";
}
function isResponseLike(value) {
  return isObject(value, true) && isPropertyAccessible(value, "status") && isPropertyAccessible(value, "statusText") && isPropertyAccessible(value, "bodyUsed");
}
var FetchRequest = class FetchRequest2 extends Request {
  static #resolveProperty(input, init = {}, key) {
    return init[key] ?? (input instanceof Request ? input[key] : void 0);
  }
  /**
  * Check if the given request method is configurable.
  * @see https://fetch.spec.whatwg.org/#methods
  */
  static isConfigurableMethod(method) {
    return method !== "CONNECT" && method !== "TRACE" && method !== "TRACK";
  }
  static isMethodWithBody(method) {
    return method !== "HEAD" && method !== "GET" && FetchRequest2.isConfigurableMethod(method);
  }
  /**
  * Check if the given request `mode` is configurable.
  * @see https://fetch.spec.whatwg.org/#concept-request-mode
  */
  static isConfigurableMode(mode) {
    return mode !== "navigate" && mode !== "websocket" && mode !== "webtransport";
  }
  constructor(input, init) {
    const method = FetchRequest2.#resolveProperty(input, init, "method") || "GET";
    const safeMethod = FetchRequest2.isConfigurableMethod(method) ? method : "GET";
    const hasExplicitBody = init != null && "body" in init;
    const bodyInit = !FetchRequest2.isMethodWithBody(method) ? { body: void 0 } : hasExplicitBody ? { body: init.body } : {};
    const mode = FetchRequest2.#resolveProperty(input, init, "mode") ?? void 0;
    const safeMode = FetchRequest2.isConfigurableMode(mode) ? mode : void 0;
    super(input, {
      ...init || {},
      method: safeMethod,
      mode: safeMode,
      duplex: init?.duplex ?? (FetchRequest2.isMethodWithBody(method) ? "half" : void 0),
      ...bodyInit
    });
    if (method !== safeMethod) this.#setInternalProperty("method", method);
    if (method === "CONNECT") {
      const url = new URL(input instanceof Request ? input.url : input);
      let authority;
      if (url.protocol === "localhost:") authority = url.href;
      else authority = url.pathname.replace(/^\/+/, "");
      Object.defineProperty(this, "url", {
        get: () => authority,
        enumerable: true,
        configurable: true
      });
    }
    if (mode != null && mode !== safeMode) this.#setInternalProperty("mode", mode);
  }
  #setInternalProperty(key, value) {
    const internalState = getValueBySymbol("state", this);
    if (internalState) Reflect.set(internalState, key, value);
    else Object.defineProperty(this, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: false
    });
  }
};
var kStatus = /* @__PURE__ */ Symbol("kStatus");
var kUrl = /* @__PURE__ */ Symbol("kUrl");
var FetchResponse = class FetchResponse2 extends Response {
  static from(response, init) {
    if (response instanceof FetchResponse2) return response;
    if (isResponseError(response)) return response;
    const fetchResponse = new FetchResponse2(response.body, {
      url: init?.url ?? response.url,
      status: init?.status || response.status,
      statusText: init?.statusText ?? response.statusText,
      headers: init?.headers ?? response.headers
    });
    copyRawHeaders(response.headers, fetchResponse.headers);
    return fetchResponse;
  }
  static {
    this.STATUS_CODES_WITHOUT_BODY = [
      101,
      103,
      204,
      205,
      304
    ];
  }
  static {
    this.STATUS_CODES_WITH_REDIRECT = [
      301,
      302,
      303,
      307,
      308
    ];
  }
  static isConfigurableStatusCode(status) {
    return status >= 200 && status <= 599;
  }
  static isRedirectResponse(status) {
    return FetchResponse2.STATUS_CODES_WITH_REDIRECT.includes(status);
  }
  /**
  * Returns a boolean indicating whether the given response status
  * code represents a response that can have a body.
  */
  static isResponseWithBody(status) {
    return !FetchResponse2.STATUS_CODES_WITHOUT_BODY.includes(status);
  }
  static setStatus(status, response) {
    const internalState = getValueBySymbol("state", response);
    if (internalState) internalState.status = status;
    else Object.defineProperty(response, "status", {
      value: status,
      enumerable: true,
      configurable: true,
      writable: false
    });
    Object.defineProperty(response, kStatus, {
      value: status,
      enumerable: false
    });
  }
  static setUrl(url, response) {
    if (!url || url === "about:" || !URL.canParse(url)) return;
    const state = getValueBySymbol("state", response);
    if (state) state.urlList.push(new URL(url));
    else Object.defineProperty(response, "url", {
      value: url,
      enumerable: true,
      configurable: true,
      writable: false
    });
    Object.defineProperty(response, kUrl, {
      value: url,
      enumerable: false
    });
  }
  /**
  * Parses the given raw HTTP headers into a Fetch API `Headers` instance.
  */
  static parseRawHeaders(rawHeaders) {
    const headers = new Headers();
    for (let line = 0; line < rawHeaders.length; line += 2) headers.append(rawHeaders[line], rawHeaders[line + 1]);
    return headers;
  }
  /**
  * Safely clones the given `Response`.
  * Coerces response clone exceptions into 500 mocked responses.
  * Handy in the environments that introduce arbitrary response
  * cloning restrictions, like "101 Switching Protocols" cloning
  * in "miniflare".
  */
  static clone(response) {
    try {
      return response.clone();
    } catch (error) {
      return Response.json(error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : {}, {
        status: 500,
        statusText: "Unclonable Response"
      });
    }
  }
  #status;
  #url;
  constructor(body, init = {}) {
    const status = init.status ?? 200;
    const safeStatus = FetchResponse2.isConfigurableStatusCode(status) ? status : 200;
    const finalBody = FetchResponse2.isResponseWithBody(status) ? body : null;
    super(finalBody, {
      status: safeStatus,
      statusText: init.statusText,
      headers: init.headers
    });
    if (status !== safeStatus) FetchResponse2.setStatus(status, this);
    FetchResponse2.setUrl(init.url, this);
  }
  clone() {
    const clonedResponse = super.clone();
    const customStatus = Reflect.get(this, kStatus);
    if (customStatus) FetchResponse2.setStatus(customStatus, clonedResponse);
    const customUrl = Reflect.get(this, kUrl);
    if (customUrl) FetchResponse2.setUrl(customUrl, clonedResponse);
    return clonedResponse;
  }
};

// node_modules/@mswjs/interceptors/lib/node/create-request-id-DHo-fRTV.js
function createRequestId() {
  return Math.random().toString(16).slice(2);
}

// node_modules/@mswjs/interceptors/lib/node/buffer-utils-B4FUq-l2.js
var encoder = new TextEncoder();
function toBuffer(data, encoding) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer);
  return Buffer.from(data, encoding);
}

// node_modules/@mswjs/interceptors/lib/node/patches-registry-DxR5TEc-.js
var PatchesRegistry = class {
  #replacements = /* @__PURE__ */ new Map();
  applyPatch(owner, key, getNextValue) {
    const ownerReplacements = this.#replacements.get(owner);
    invariant(!ownerReplacements?.has(key), `Failed to replace a global value at "${String(key)}": already replaced.`);
    const match = getDeepPropertyDescriptor(owner, key);
    if (typeof match === "undefined") {
      console.warn(`Failed to replace a global value at "${String(key)}": not a global value.`);
      return () => {
      };
    }
    if (match.descriptor.configurable) Object.defineProperty(owner, key, {
      value: getNextValue(owner[key]),
      enumerable: true,
      configurable: true
    });
    else if (match.descriptor.writable) owner[key] = getNextValue(owner[key]);
    else throw new Error(`Failed to patch a non-configurable non-writable property "${key.toString()}"`);
    const restorePatch = () => {
      const currentReplacements = this.#replacements.get(owner);
      if (!currentReplacements?.has(key)) return;
      if (match.owner === owner)
        Object.defineProperty(match.owner, key, match.descriptor);
      else
        Reflect.deleteProperty(owner, key);
      currentReplacements.delete(key);
      if (currentReplacements.size === 0) this.#replacements.delete(owner);
    };
    if (ownerReplacements) ownerReplacements.set(key, restorePatch);
    else this.#replacements.set(owner, /* @__PURE__ */ new Map([[key, restorePatch]]));
    return restorePatch;
  }
  restoreAllPatches() {
    const errors = [];
    for (const [, ownerReplacements] of this.#replacements) for (const [, restorePatch] of ownerReplacements) try {
      restorePatch();
    } catch (error) {
      if (error instanceof Error) errors.push(error);
      else throw error;
    }
    if (errors.length > 0) throw new AggregateError(errors, "FOO!");
  }
};
var patchesRegistry = new PatchesRegistry();
function getDeepPropertyDescriptor(owner, key) {
  let currentOwner = owner;
  let descriptor;
  while (currentOwner) {
    descriptor = Object.getOwnPropertyDescriptor(currentOwner, key);
    if (descriptor) return {
      owner: currentOwner,
      descriptor
    };
    currentOwner = Object.getPrototypeOf(currentOwner);
  }
}

// node_modules/@mswjs/interceptors/lib/node/net-B3HDxRlp.js
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";
import tls from "node:tls";
function normalizeNetConnectArgs(args) {
  if (args.length === 0) return [{ path: "" }, null];
  const callback = typeof args[1] === "function" ? args[1] : args[2] || null;
  if (typeof args[0] === "string") return [{ path: args[0] }, callback];
  if (typeof args[0] === "number") return [{
    port: args[0],
    path: "",
    /**
    * @note The host is optional in the "(port[, host][, callback])"
    * signatures and defaults to "localhost" in Node.js.
    */
    host: typeof args[1] === "string" ? args[1] : void 0
  }, callback];
  if (typeof args[0] === "object") {
    if ("port" in args[0]) return [{
      path: "",
      port: Reflect.get(args[0], "port"),
      host: Reflect.get(args[0], "host"),
      auth: Reflect.get(args[0], "auth"),
      family: Reflect.get(args[0], "family"),
      hints: Reflect.get(args[0], "hints"),
      session: Reflect.get(args[0], "session"),
      localAddress: Reflect.get(args[0], "localAddress"),
      localPort: Reflect.get(args[0], "localPort"),
      timeout: Reflect.get(args[0], "timeout"),
      lookup: Reflect.get(args[0], "lookup"),
      allowHalfOpen: Reflect.get(args[0], "allowHalfOpen"),
      noDelay: Reflect.get(args[0], "noDelay"),
      keepAlive: Reflect.get(args[0], "keepAlive"),
      keepAliveInitialDelay: Reflect.get(args[0], "keepAliveInitialDelay"),
      autoSelectFamily: Reflect.get(args[0], "autoSelectFamily"),
      autoSelectFamilyAttemptTimeout: Reflect.get(args[0], "autoSelectFamilyAttemptTimeout")
    }, callback];
    return [{
      path: args[0].path || "",
      family: Reflect.get(args[0], "family"),
      session: Reflect.get(args[0], "session"),
      auth: Reflect.get(args[0], "auth"),
      timeout: Reflect.get(args[0], "timeout"),
      allowHalfOpen: Reflect.get(args[0], "allowHalfOpen")
    }, callback];
  }
  throw new Error(`Invalid arguments passed to net.connect: ${args}`);
}
function writePendingData(socket, data, encoding, callback) {
  if (Array.isArray(data)) {
    for (let index = 0; index < data.length; index++) {
      const entry = data[index];
      if (index === data.length - 1) socket.write(entry.chunk, entry.encoding, callback);
      else socket.write(entry.chunk, entry.encoding);
    }
    return;
  }
  socket.write(data, encoding, callback);
}
function unwrapPendingData(data, callback) {
  if (Array.isArray(data)) for (const entry of data) callback(entry.chunk, entry.encoding, entry.callback);
  else callback(data);
}
function getTlsConnectOptions(socket) {
  const kConnectOptions = Object.getOwnPropertySymbols(socket).find((symbol) => {
    return symbol.description === "connect-options";
  });
  if (kConnectOptions == null) return;
  return Reflect.get(socket, kConnectOptions);
}
function getAddressInfoByConnectionOptions(options) {
  if (options == null) return {};
  const isIPv6 = options.family === 6 || net.isIPv6(options.host || "");
  return {
    address: isIPv6 ? "::1" : "127.0.0.1",
    /**
    * @note Coerce the port to a number. Connection options may
    * describe it as a string (e.g. when created from a URL), while
    * the address info always reports a numeric port.
    */
    port: Number(options.port) || (options.protocol === "https:" ? 443 : 80),
    family: isIPv6 ? "IPv6" : "IPv4"
  };
}
function getLocalAddressInfoByConnectionOptions(options) {
  if (options == null) return {};
  const isIPv6 = options.family === 6 || net.isIPv6(options.host || "");
  return {
    address: options.localAddress || (isIPv6 ? "::1" : "127.0.0.1"),
    port: options.localPort || getEphemeralPort(),
    family: isIPv6 ? "IPv6" : "IPv4"
  };
}
function getEphemeralPort() {
  return 49152 + Math.floor(Math.random() * 16384);
}
var kListenerWrap = /* @__PURE__ */ Symbol("kListenerWrap");
var kRawSocket = /* @__PURE__ */ Symbol("kRawSocket");
var kPatched = /* @__PURE__ */ Symbol("kPatched");
var logger$1 = createLogger("socket");
function toServerSocket(socket) {
  const pendingWrites = [];
  let pendingEnd;
  let isBackpressured = false;
  let isFlushScheduled = false;
  const flushPendingWrites = () => {
    if (socket.connecting) {
      isBackpressured = true;
      if (!isFlushScheduled) {
        isFlushScheduled = true;
        socket.once("ready", () => {
          isFlushScheduled = false;
          flushPendingWrites();
        });
      }
      return false;
    }
    while (pendingWrites.length > 0) {
      const nextWrite = pendingWrites.shift();
      socket._unrefTimer();
      const canPushMore = socket.push(toBuffer(nextWrite.chunk, nextWrite.encoding), nextWrite.encoding);
      nextWrite.callback?.();
      if (!canPushMore) {
        isBackpressured = true;
        return false;
      }
    }
    const wasBackpressured = isBackpressured;
    isBackpressured = false;
    if (pendingEnd) {
      const finalEnd = pendingEnd;
      pendingEnd = void 0;
      if (finalEnd.chunk != null) socket.push(toBuffer(finalEnd.chunk, finalEnd.encoding), finalEnd.encoding);
      socket.push(null);
      finalEnd.callback?.();
    }
    if (wasBackpressured) socket.emit("internal:drain");
    return true;
  };
  const realRead = socket._read.bind(socket);
  socket._read = (size) => {
    realRead(size);
    if (pendingWrites.length > 0 || pendingEnd != null || isBackpressured) flushPendingWrites();
  };
  return new Proxy(socket, { get: (target, property, receiver) => {
    const getRealValue = () => {
      return Reflect.get(target, property, receiver);
    };
    if (property === "on" || property === "addListener" || property === "once" || property === "prependListener" || property === "prependOnceListener") {
      const realAddListener = getRealValue();
      return (event, listener) => {
        if (event === "data") {
          const listenerWrap = (chunk, encoding) => {
            listener(toBuffer(chunk, encoding));
          };
          Object.defineProperty(listener, kListenerWrap, {
            enumerable: false,
            writable: true,
            value: listenerWrap
          });
          Reflect.apply(realAddListener, target, ["internal:write", listenerWrap]);
          return target;
        }
        if (event === "drain") {
          Reflect.apply(realAddListener, target, ["internal:drain", listener]);
          return target;
        }
        return realAddListener.call(target, event, listener);
      };
    }
    if (property === "off" || property === "removeListener") {
      const realRemoveListener = getRealValue();
      return (event, listener) => {
        if (event === "data") {
          const listenerWrap = listener[kListenerWrap];
          if (listenerWrap) return realRemoveListener.call(target, "internal:write", listenerWrap);
        }
        if (event === "drain") return realRemoveListener.call(target, "internal:drain", listener);
        return realRemoveListener.call(target, event, listener);
      };
    }
    if (property === "write") return ((chunk, encoding, callback) => {
      if (typeof encoding === "function") {
        callback = encoding;
        encoding = void 0;
      }
      pendingWrites.push({
        chunk,
        encoding,
        callback
      });
      if (isBackpressured) return false;
      return flushPendingWrites();
    });
    if (property === "end") return ((...args) => {
      const callback = args[args.length - 1];
      pendingEnd = {
        chunk: typeof args[0] === "function" ? void 0 : args[0],
        encoding: typeof args[1] === "string" ? args[1] : void 0,
        callback: typeof callback === "function" ? callback : void 0
      };
      flushPendingWrites();
      return target;
    });
    return getRealValue();
  } });
}
var SocketController = class SocketController2 {
  static {
    this.PENDING = 0;
  }
  static {
    this.CLAIMED = 1;
  }
  static {
    this.PASSTHROUGH = 2;
  }
  constructor(socket) {
    this[kRawSocket] = socket;
    socket[kPatched] = true;
    this.readyState = SocketController2.PENDING;
  }
  /**
  * Claim this socket. Once claimed, the connection attempt succeeds
  * regardless of the requested host and the interceptor becomes the
  * mocked server for this connection.
  */
  claim() {
    invariant(this.readyState === SocketController2.PENDING, "Failed to claim a socket connection: already handled (%s)", this.readyState);
    this.readyState = SocketController2.CLAIMED;
  }
  /**
  * Establish this socket connection as-is.
  */
  passthrough() {
    invariant(this.readyState === SocketController2.PENDING, "Failed to passthrough a socket connection: already handled (%s)", this.readyState);
    this.readyState = SocketController2.PASSTHROUGH;
  }
};
var TcpSocketController = class extends SocketController {
  #removePassthroughSocketListeners;
  #connectionOptions;
  #retargetedConnectionOptions;
  #realWriteGeneric;
  #passthroughSocket = null;
  #bufferedWrites = [];
  #readsCorked = false;
  #corkedReads = [];
  #realHandleSwapped = false;
  #resetScheduled = false;
  #clientCloseEmitted = false;
  #clientEndPushed = false;
  #connectEmulated = false;
  constructor(socket, createConnection, connectionOptions) {
    super(socket);
    this.socket = socket;
    this.createConnection = createConnection;
    this.#connectionOptions = connectionOptions;
    this.socket._read = () => {
      this.#passthroughSocket?.resume();
    };
    this.#realWriteGeneric = this.socket._writeGeneric;
    this.#bufferedWrites = [];
    this.socket._writeGeneric = (...args) => {
      this.#handleWrite(args);
    };
    this.socket.connect = new Proxy(this.socket.connect, { apply: (target, thisArg, args) => {
      logger$1.verbose("socket.connect() %o", args);
      this.#connectionOptions = args[0];
      if (args[0] != null && typeof args[0] === "object" && (args[0].localAddress != null || args[0].localPort != null)) args[0] = {
        ...args[0],
        localAddress: void 0,
        localPort: void 0
      };
      return Reflect.apply(target, thisArg, args);
    } });
    socket.on("free", () => {
      logger$1.verbose("client socket freed!");
      this.reset();
    }).on("close", () => {
      logger$1.verbose("client socket closed!");
      this.#clientCloseEmitted = true;
      this.#passthroughSocket?.destroy();
      this.#passthroughSocket = null;
      this.#bufferedWrites = [];
      this.#readsCorked = false;
      this.#corkedReads = [];
    });
    this.serverSocket = toServerSocket(this.socket);
    this.pendingConnection = Promise.withResolvers();
    this.#reset();
  }
  /**
  * Reset this controller to the pending state so the next exchange
  * on this socket can be handled anew. This is meant for kept-alive
  * sockets that are reused for multiple exchanges by clients that
  * don't emit the "free" event on the socket (e.g. Undici).
  *
  * Providing connection options retargets this connection: the
  * exchanges that follow belong to the given target (e.g. the
  * authority of an established "CONNECT" tunnel). An unclaimed
  * exchange then passes through to that target instead of the
  * originally dialed one, and a claimed exchange reports it as the
  * peer.
  */
  reset(connectionOptions) {
    if (connectionOptions != null) {
      this.#retargetedConnectionOptions = connectionOptions;
      this.#connectionOptions = connectionOptions;
      if (this.#passthroughSocket) {
        this.#removePassthroughSocketListeners?.();
        this.#passthroughSocket.destroy();
        this.#passthroughSocket = null;
        this.#realHandleSwapped = false;
      }
    }
    if (this.readyState === SocketController.PENDING) return;
    this.#reset();
  }
  /**
  * Schedule a reset of this controller to happen right before the
  * next client write. The consumer signals the boundary of the
  * current exchange (e.g. an HTTP message boundary) the moment it is
  * parsed — mid-delivery of the exchange's final chunk — when an
  * immediate reset would discard that chunk. Deferring the reset to
  * the next write lets the current exchange settle as-is while the
  * next exchange's first write already buffers for a new verdict
  * (instead of following the previous one, e.g. leaking to the
  * passthrough connection).
  */
  scheduleReset() {
    this.#resetScheduled = true;
  }
  #reset() {
    logger$1.verbose("resetting the socket...");
    this.#resetScheduled = false;
    this.readyState = SocketController.PENDING;
    this.pendingConnection = Promise.withResolvers();
    this.#bufferedWrites = [];
    this.#connectEmulated = false;
    this.socket._pendingData = null;
    this.socket._pendingEncoding = "";
    const wrapHandle = (handle) => {
      this.pendingConnection.promise.then(() => {
        logger$1.verbose("connection request resolved!", this.readyState);
        process.nextTick(() => {
          if (this.readyState === SocketController.PENDING && this.socket.connecting && this.#bufferedWrites.length === 0 && this.socket.listenerCount("connect") > 0) {
            logger$1.verbose('assume connect->write socket, calling "connect" listeners...');
            this.emulateConnect();
          }
        });
      });
      if (handle.setTypeOfService) handle.setTypeOfService = void 0;
      handle.connect = handle.connect6 = (request) => {
        logger$1.verbose("handle.connect()");
        this.pendingConnection.resolve([request, handle]);
      };
      logger$1.verbose("socket handle wrapped! waiting for connection request...");
    };
    if (this.socket._handle) wrapHandle(this.socket._handle);
    else this.socket.prependOnceListener("connectionAttempt", () => {
      wrapHandle(this.socket._handle);
    });
  }
  /**
  * Handle a write performed on the client socket. Installed once as
  * "_writeGeneric", this is the single write path for every controller
  * state, dispatching on "readyState".
  */
  #handleWrite(args) {
    const data = args[1];
    logger$1.verbose("socket write (state: %d) %o", this.readyState, args);
    if (this.#resetScheduled) this.reset();
    this.#bufferedWrites.push(args);
    if (this.readyState === SocketController.PENDING) {
      const pendingData = Array.isArray(this.socket._pendingData) ? this.socket._pendingData : [];
      unwrapPendingData(data, (chunk, chunkEncoding) => {
        pendingData.push({
          chunk,
          encoding: chunkEncoding
        });
      });
      this.socket._pendingData = pendingData;
      if (this.socket.listenerCount("internal:write") === 0) {
        logger$1.verbose("no server data listeners, scheduling to the next tick...");
        process.nextTick(() => {
          this.#push(data);
        });
      } else this.#push(data);
    } else this.#push(data);
    switch (this.readyState) {
      case SocketController.PENDING:
        if (!this.#bufferedWrites.includes(args)) this.#bufferedWrites.push(args);
        this.#acknowledgeWrite(args);
        return;
      case SocketController.CLAIMED:
        this.#removeBufferedWrite(args);
        this.#acknowledgeWrite(args);
        return;
      case SocketController.PASSTHROUGH:
        if (!this.#removeBufferedWrite(args)) return;
        if (!this.#realHandleSwapped && this.#passthroughSocket) {
          writePendingData(this.#passthroughSocket, data, args[2], args[3]);
          return;
        }
        this.#realWriteGeneric.apply(this.socket, args);
    }
  }
  /**
  * Complete the given write by invoking its callback. The callback is
  * then removed from the write entry so flushing that entry later
  * (e.g. on passthrough) does not invoke it twice.
  */
  #acknowledgeWrite(args) {
    const callback = args[3];
    if (typeof callback === "function") {
      callback();
      args[3] = void 0;
    }
  }
  #removeBufferedWrite(args) {
    const index = this.#bufferedWrites.indexOf(args);
    if (index === -1) return false;
    this.#bufferedWrites.splice(index, 1);
    return true;
  }
  emulateConnect() {
    this.#connectEmulated = true;
    Reflect.set(this.socket, "connecting", false);
    for (const listener of this.socket.rawListeners("connect")) listener.apply(this.socket);
  }
  /**
  * Push the given data to the server socket.
  * This has no effect on the public-facing socket and is used
  * only for the interceptors to subscribe to "socket.on('data')"
  * before the data is actually written anywhere.
  */
  #push = (data) => {
    if (data == null) return;
    logger$1.verbose("server push %o", data);
    unwrapPendingData(data, (chunk, encoding) => {
      logger$1.verbose('server emitting "data" %o', {
        chunk,
        encoding
      });
      this.socket.emit("internal:write", chunk, encoding);
    });
  };
  #onRealSocketConnect = () => {
    if (!this.#passthroughSocket) return;
    if (this.socket.destroyed) {
      this.#passthroughSocket.destroy();
      return;
    }
    const replacedHandle = this.socket._handle;
    const wasUnrefed = replacedHandle != null && typeof replacedHandle.hasRef === "function" && !replacedHandle.hasRef();
    this.socket._handle = this.#passthroughSocket._handle;
    this.#realHandleSwapped = true;
    if (wasUnrefed) this.socket._handle.unref?.();
    if (replacedHandle != null) {
      replacedHandle.close();
      replacedHandle._parent?.close();
    }
    Reflect.set(this.socket, "connecting", false);
    this.socket.remoteAddress;
    this.socket.emit("connect");
    this.socket.emit("ready");
  };
  #onRealSocketConnectionAttemptFailed = (address, port, family, error) => {
    this.socket.emit("connectionAttemptFailed", address, port, family, error);
  };
  #onRealSocketConnectionAttemptTimeout = (address, port, family) => {
    this.socket.emit("connectionAttemptTimeout", address, port, family);
  };
  #onRealSocketData = (data) => {
    logger$1.verbose('real socket "data" event %o', data);
    this.socket._unrefTimer();
    if (this.#readsCorked) {
      logger$1.verbose("reads are corked, buffering the data...");
      this.#corkedReads.push({
        type: "data",
        chunk: data
      });
      return;
    }
    if (!this.socket.push(data)) {
      logger$1.verbose("client socket forbade more pushes, pausing the passthrough socket...");
      this.#passthroughSocket?.pause();
    }
  };
  #onRealSocketError = (error) => {
    logger$1.verbose('real socket "error" event %o', error);
    if (this.socket.destroyed) {
      logger$1.verbose("real socket errored but client socket already destroyed, skipping...");
      return;
    }
    logger$1.verbose("real socket errored, forwarding %o", error);
    this.socket.destroy(error);
    if (this.#realHandleSwapped) process.nextTick(() => this.socket.emit("close", true));
  };
  #onRealSocketEnd = () => {
    this.socket._unrefTimer();
    if (this.#readsCorked) {
      this.#corkedReads.push({ type: "end" });
      return;
    }
    this.#clientEndPushed = true;
    this.socket.push(null);
  };
  #onRealSocketClose = (hadError) => {
    if (this.#realHandleSwapped && this.socket._handle) this.socket._handle.shutdown = () => 1;
    if (this.#readsCorked) {
      this.#corkedReads.push({
        type: "close",
        hadError
      });
      return;
    }
    if (this.#clientCloseEmitted) return;
    if (this.socket.destroyed && !this.#realHandleSwapped) return;
    this.#emitClientClose(hadError);
  };
  /**
  * Emit the "close" event on the client socket, honoring the order
  * of the socket teardown events.
  * @note The client may be paused with the received data (and the
  * end-of-stream) still buffered. Node.js never emits "close" before
  * "end" on a gracefully closed connection: the teardown waits until
  * the consumer reads the buffered data.
  */
  #emitClientClose(hadError) {
    if (this.#clientCloseEmitted) return;
    if (this.#clientEndPushed && !this.socket.readableEnded && !this.socket.destroyed) {
      let closeDelivered = false;
      const deliverClose = (hadErrorOverride) => {
        if (closeDelivered) return;
        closeDelivered = true;
        process.nextTick(() => {
          this.#emitClientClose(hadErrorOverride ?? hadError);
        });
      };
      this.socket.once("end", () => {
        deliverClose();
      });
      const realDestroy = this.socket._destroy;
      this.socket._destroy = (error, callback) => {
        deliverClose(error != null);
        return realDestroy.call(this.socket, error, callback);
      };
      return;
    }
    this.socket.destroy();
    if (this.#realHandleSwapped) this.socket.emit("close", hadError);
  }
  #onMockSocketDrain = () => {
    logger$1.verbose("client socket drained!");
    this.#passthroughSocket?.resume();
  };
  /**
  * Forward the client's half-close to the passthrough socket.
  * The client's writable side may finish before the real handle is
  * swapped in ("_final" of a connected client runs against the mock
  * handle), leaving the FIN unsent. Once the handle is swapped, the
  * client's own shutdown reaches the real connection natively.
  */
  #forwardClientFinish = () => {
    if (!this.#realHandleSwapped) this.#passthroughSocket?.end();
  };
  /**
  * Suspend forwarding of the passthrough socket events ("data", "end", "close")
  * to the client socket. The events are buffered in order until `uncorkReads()`
  * is called. This allows the consumer to delay the delivery of the original
  * response to the client (e.g. until its own asynchronous logic settles).
  *
  * @note Pausing the client socket is not enough to delay the delivery.
  * Consumers like Undici read the pushed data from a paused socket
  * directly via `socket.read()`, which is unaffected by `socket.pause()`.
  */
  corkReads() {
    this.#readsCorked = true;
  }
  /**
  * Resume forwarding of the passthrough socket events to the client socket,
  * replaying any events buffered while the reads were corked.
  */
  uncorkReads() {
    if (!this.#readsCorked) return;
    this.#readsCorked = false;
    for (const corkedRead of this.#corkedReads.splice(0)) switch (corkedRead.type) {
      case "data":
        if (!this.socket.push(corkedRead.chunk)) {
          logger$1.verbose("client socket forbade more pushes, pausing the passthrough socket...");
          this.#passthroughSocket?.pause();
        }
        break;
      case "end":
        this.#clientEndPushed = true;
        this.socket.push(null);
        break;
      case "close":
        this.#emitClientClose(corkedRead.hadError);
        break;
    }
  }
  claim() {
    super.claim();
    if (this.socket.destroyed) {
      logger$1.verbose("socket already destroyed, skipping claim...");
      return;
    }
    if (!this.socket.connecting && !this.#connectEmulated) {
      logger$1.verbose("socket already connected, skipping claim...");
      return;
    }
    logger$1.verbose("-> claim!");
    this.socket._handle.getsockname = (addressInfo) => {
      Object.assign(addressInfo, getLocalAddressInfoByConnectionOptions(this.#connectionOptions));
      return 0;
    };
    this.socket._handle.getpeername = (addressInfo) => {
      Object.assign(addressInfo, getAddressInfoByConnectionOptions(this.#connectionOptions));
      return 0;
    };
    this.#bufferedWrites = [];
    this.socket._pendingData = null;
    this.socket._pendingEncoding = "";
    this.pendingConnection.promise.then(([request, handle]) => {
      logger$1.verbose("connection request resolved, mocking the connection...");
      if (this.#connectEmulated) Reflect.set(this.socket, "connecting", true);
      request.oncomplete(0, handle, request, true, true);
    });
  }
  passthrough(flushPendingData) {
    super.passthrough();
    logger$1.verbose("-> passthrough!");
    const createRealSocket = () => {
      const realSocket2 = this.#retargetedConnectionOptions ? this.#createRetargetedConnection(this.#retargetedConnectionOptions) : this.createConnection();
      realSocket2[kPatched] = true;
      realSocket2.allowHalfOpen = true;
      if (this.socket.timeout != null) realSocket2.setTimeout(this.socket.timeout);
      return realSocket2;
    };
    const realSocket = this.#passthroughSocket && !this.#passthroughSocket.destroyed ? this.#passthroughSocket : createRealSocket();
    const isNewConnection = realSocket !== this.#passthroughSocket;
    this.#passthroughSocket = realSocket;
    if (this.#bufferedWrites.length === 0) logger$1.verbose("passthrough with empty writes buffer (state: %d)", this.readyState);
    for (let i = 0; i < this.#bufferedWrites.length; i++) {
      const pendingWrite = this.#bufferedWrites[i];
      if (i === 0 && typeof flushPendingData === "function") {
        const data2 = pendingWrite[1];
        const encoding2 = pendingWrite[2];
        flushPendingData(data2, encoding2, (nextData) => {
          pendingWrite[1] = nextData;
        });
      }
      const [, data, encoding, callback] = pendingWrite;
      writePendingData(realSocket, data, encoding, callback);
    }
    this.#bufferedWrites = [];
    this.socket._pendingData = null;
    this.socket._pendingEncoding = "";
    this.socket.address = realSocket.address.bind(realSocket);
    this.socket.removeListener("drain", this.#onMockSocketDrain);
    this.socket.on("drain", this.#onMockSocketDrain);
    if (isNewConnection) {
      this.#removePassthroughSocketListeners = this.addPassthroughSocketListeners(realSocket);
      realSocket.once("close", this.#removePassthroughSocketListeners);
    }
    if (!this.#realHandleSwapped) if (this.socket.writableFinished) this.#forwardClientFinish();
    else {
      this.socket.removeListener("finish", this.#forwardClientFinish);
      this.socket.once("finish", this.#forwardClientFinish);
    }
    return realSocket;
  }
  /**
  * Forward events for the lifetime of the connection, including while
  * it is idle in an agent pool. Reusing it must not add more listeners.
  */
  addPassthroughSocketListeners(realSocket) {
    realSocket.once("connect", this.#onRealSocketConnect).on("connectionAttemptFailed", this.#onRealSocketConnectionAttemptFailed).on("connectionAttemptTimeout", this.#onRealSocketConnectionAttemptTimeout).on("data", this.#onRealSocketData).on("error", this.#onRealSocketError).on("end", this.#onRealSocketEnd).on("close", this.#onRealSocketClose);
    return () => {
      realSocket.removeListener("connect", this.#onRealSocketConnect).removeListener("connectionAttemptFailed", this.#onRealSocketConnectionAttemptFailed).removeListener("connectionAttemptTimeout", this.#onRealSocketConnectionAttemptTimeout).removeListener("data", this.#onRealSocketData).removeListener("error", this.#onRealSocketError).removeListener("end", this.#onRealSocketEnd).removeListener("close", this.#onRealSocketClose);
    };
  }
  /**
  * Create the passthrough connection to the target this controller
  * was retargeted to (see `reset()`). The original `createConnection`
  * dials the originally requested target and cannot serve retargeted
  * exchanges.
  */
  #createRetargetedConnection(connectionOptions) {
    const realSocket = new net.Socket();
    realSocket[kPatched] = true;
    return realSocket.connect(connectionOptions);
  }
};
var TlsSocketController = class extends TcpSocketController {
  /**
  * @note The TLS connection options must be provided explicitly.
  * They cannot be captured from "socket.connect()" like for plain
  * TCP sockets because "tls.connect()" fixes them at the TLS socket
  * construction, before its transport ever connects.
  */
  #tlsConnectionOptions;
  constructor(socket, createConnection, tlsConnectionOptions) {
    super(socket, createConnection, tlsConnectionOptions);
    this.socket = socket;
    this.createConnection = createConnection;
    this.#tlsConnectionOptions = tlsConnectionOptions;
    socket.prependListener("secureConnect", () => {
      socket.alpnProtocol = socket._handle.getALPNNegotiatedProtocol();
    });
  }
  emulateConnect() {
    if (this.#tlsConnectionOptions) {
      const alpnProtocol = this.socket._handle.getALPNNegotiatedProtocol();
      this.#tlsConnectionOptions.ALPNProtocols = alpnProtocol ? [alpnProtocol] : [];
    }
    super.emulateConnect();
    for (const listener of this.socket.rawListeners("secureConnect")) listener.apply(this.socket);
  }
  claim() {
    if (this.socket.destroyed) {
      super.claim();
      return;
    }
    this.socket.prependOnceListener("secureConnect", () => {
      Reflect.set(this.socket, "authorized", false);
      Reflect.set(this.socket, "authorizationError", "MOCKED_CONNECTION_NOT_VERIFIED");
    });
    const handle = this.socket._handle;
    handle.start = () => void 0;
    handle.verifyError = () => void 0;
    handle.getSession = () => {
      return Buffer.from("mocked session");
    };
    const realTlsConnectOptions = getTlsConnectOptions(this.socket);
    if (realTlsConnectOptions) realTlsConnectOptions.checkServerIdentity = () => {
    };
    handle.getCipher = () => {
      return {
        name: "TLS_AES_256_GCM_SHA384",
        standardName: "TLS_AES_256_GCM_SHA384",
        version: "TLSv1.3"
      };
    };
    handle.getEphemeralKeyInfo = () => {
      return {
        type: "ECDH",
        name: "X25519",
        size: 253
      };
    };
    const requestedAlpnProtocols = this.#tlsConnectionOptions?.ALPNProtocols;
    if (Array.isArray(requestedAlpnProtocols) && requestedAlpnProtocols.length > 0) {
      const [preferredProtocol] = requestedAlpnProtocols;
      handle.getALPNNegotiatedProtocol = () => {
        return typeof preferredProtocol === "string" ? preferredProtocol : false;
      };
    }
    this.socket.once("connect", () => {
      const mockedClientRandom = "0".repeat(64);
      const mockedSecret = "0".repeat(96);
      for (const keylogLabel of [
        "SERVER_HANDSHAKE_TRAFFIC_SECRET",
        "EXPORTER_SECRET",
        "SERVER_TRAFFIC_SECRET_0",
        "CLIENT_HANDSHAKE_TRAFFIC_SECRET",
        "CLIENT_TRAFFIC_SECRET_0"
      ]) this.socket.emit("keylog", Buffer.from(`${keylogLabel} ${mockedClientRandom} ${mockedSecret}
`));
      handle.onhandshakedone();
      handle.onnewsession(1, Buffer.from("mocked session"));
      handle.onnewsession(2, Buffer.from("mocked session"));
    });
    super.claim();
  }
  passthrough(flushPendingData) {
    const realSocket = super.passthrough(flushPendingData);
    for (const connectListener of this.socket.listeners("connect")) if (connectListener === this.socket._start || "listener" in connectListener && connectListener.listener === this.socket._start) this.socket.removeListener("connect", connectListener);
    return realSocket;
  }
  #onRealSocketSecure = () => {
    this.socket.emit("secure");
  };
  #onRealSocketSession = (session) => {
    this.socket.emit("session", session);
  };
  #onRealSocketKeylog = (line) => {
    this.socket.emit("keylog", line);
  };
  #onRealSocketOCSPResponse = (response) => {
    this.socket.emit("OCSPResponse", response);
  };
  addPassthroughSocketListeners(realSocket) {
    const removeTcpSocketListeners = super.addPassthroughSocketListeners(realSocket);
    realSocket.on("secure", this.#onRealSocketSecure).on("session", this.#onRealSocketSession).on("keylog", this.#onRealSocketKeylog).on("OCSPResponse", this.#onRealSocketOCSPResponse);
    return () => {
      removeTcpSocketListeners();
      realSocket.removeListener("secure", this.#onRealSocketSecure).removeListener("session", this.#onRealSocketSession).removeListener("keylog", this.#onRealSocketKeylog).removeListener("OCSPResponse", this.#onRealSocketOCSPResponse);
    };
  }
};
function normalizeTlsConnectArgs(args) {
  const netConnectArgs = normalizeNetConnectArgs(args);
  const options = netConnectArgs[0];
  const callback = netConnectArgs[1];
  if (args[0] !== null && typeof args[0] === "object") Object.assign(options, args[0]);
  else if (args[1] !== null && typeof args[1] === "object") Object.assign(options, args[1]);
  else if (args[2] !== null && typeof args[2] === "object") Object.assign(options, args[2]);
  return callback ? [options, callback] : [options];
}
globalThis.__MSW_INTERNAL_CONNECTION_CONTEXT ??= (() => {
  const context = new AsyncLocalStorage();
  return {
    run(callback) {
      return context.run({ consumed: false }, callback);
    },
    consume() {
      const connection = context.getStore();
      if (!connection || connection.consumed) return false;
      connection.consumed = true;
      return true;
    }
  };
})();
var SocketConnectionEvent = class extends TypedEvent {
  constructor(data) {
    super(...["connection", {}]);
    this.socket = data.socket;
    this.connectionOptions = data.connectionOptions;
    this.controller = data.controller;
  }
};
var logger = createLogger("socket");
var mockLookup = (hostname, dnsOptions, callback) => {
  const family = dnsOptions.family === 6 ? 6 : 4;
  const address = family === 6 ? "::1" : "127.0.0.1";
  process.nextTick(() => {
    if (dnsOptions.all) {
      callback(null, [{
        address,
        family
      }]);
      return;
    }
    callback(null, address, family);
  });
};
var SocketInterceptor = class extends Interceptor {
  static {
    this.symbol = /* @__PURE__ */ Symbol.for("socket-interceptor");
  }
  predicate() {
    return true;
  }
  setup() {
    const interceptor2 = this;
    let isCreatingPassthroughConnection = false;
    this.subscriptions.push(
      /**
      * @note Intercept connections at the "net.Socket.prototype.connect"
      * level instead of patching the "net.connect()" module function.
      * ESM consumers snapshot the module bindings at import time
      * ("import * as net from 'node:net'"), so reassigning "net.connect"
      * is invisible to them. Every client connection ends up calling
      * "Socket.prototype.connect" (including the one made by the original
      * "net.connect()"), and prototype mutations are visible regardless
      * of how the module was imported.
      */
      patchesRegistry.applyPatch(net.Socket.prototype, "connect", (realSocketConnect) => {
        return function connect(...args) {
          const socket = this;
          if (socket[kPatched] || isCreatingPassthroughConnection) return realSocketConnect.apply(socket, args);
          if (globalThis.__MSW_INTERNAL_CONNECTION_CONTEXT?.consume()) {
            socket[kPatched] = true;
            return realSocketConnect.apply(socket, args);
          }
          logger.verbose("socket.connect() %o", args);
          const connectArgs = Array.isArray(args[0]) ? args[0] : args;
          const [transportConnectionOptions, connectionCallback] = normalizeNetConnectArgs(connectArgs);
          logger.verbose("connection options %o", {
            transportConnectionOptions,
            connectionCallback
          });
          let controller;
          let connectionOptions;
          if (socket instanceof tls.TLSSocket) {
            const realTlsConnectionOptions = getTlsConnectOptions(socket);
            const [tlsConnectionOptions] = normalizeTlsConnectArgs([{
              ...transportConnectionOptions,
              ...realTlsConnectionOptions
            }]);
            connectionOptions = tlsConnectionOptions;
            controller = new TlsSocketController(socket, () => {
              isCreatingPassthroughConnection = true;
              try {
                return tls.connect(tlsConnectionOptions);
              } finally {
                isCreatingPassthroughConnection = false;
              }
            }, tlsConnectionOptions);
          } else {
            const passthroughArgs = connectArgs.filter((arg) => {
              return typeof arg !== "function";
            });
            const socketOptions = connectArgs[0] !== null && typeof connectArgs[0] === "object" && !("href" in connectArgs[0]) ? connectArgs[0] : {};
            connectionOptions = transportConnectionOptions;
            controller = new TcpSocketController(socket, () => {
              const passthroughSocket = new net.Socket(socketOptions);
              Reflect.apply(realSocketConnect, passthroughSocket, passthroughArgs);
              return passthroughSocket;
            });
          }
          process.nextTick(async () => {
            if (socket.destroyed) return;
            if (interceptor2.listenerCount("connection") === 0) {
              controller.passthrough();
              return;
            }
            try {
              await interceptor2.emitter.emitAsPromise(new SocketConnectionEvent({
                socket: controller.serverSocket,
                controller,
                connectionOptions
              }));
            } catch (error) {
              socket.destroy(error);
              return;
            }
            logger.verbose('emitted "connection" event!');
          });
          logger.verbose("connecting the socket...");
          const mockConnectionOptions = { ...transportConnectionOptions };
          mockConnectionOptions.lookup = mockLookup;
          try {
            return socket.connect(mockConnectionOptions, connectionCallback ?? void 0);
          } catch (error) {
            socket.destroy();
            throw error;
          }
        };
      }),
      this.#stopReusingUnpatchedSockets()
    );
  }
  /**
  * Prevent the `net.Socket` instances created before this interceptor
  * was applied from getting reused by an `Agent`. Purging them from the
  * keep-alive pool forces the agent to establish new (intercepted)
  * connections instead.
  */
  #stopReusingUnpatchedSockets() {
    if (typeof http.Agent.prototype.addRequest !== "function") return () => {
    };
    return patchesRegistry.applyPatch(http.Agent.prototype, "addRequest", (realAddRequest) => {
      return function(...args) {
        for (const sockets of Object.values(this.freeSockets)) {
          if (sockets == null) continue;
          for (const socket of sockets) if (!socket[kPatched]) socket.destroy();
        }
        return realAddRequest?.apply(this, args);
      };
    });
  }
};

// node_modules/@mswjs/interceptors/lib/node/source-Bc2l3K3h.js
import { IncomingMessage, METHODS, STATUS_CODES, ServerResponse } from "node:http";
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
import net2 from "node:net";
import tls2 from "node:tls";
import { Readable } from "node:stream";
import fs from "node:fs";

// node_modules/@open-draft/until/lib/index.js
async function until(callback) {
  try {
    return [null, await callback().catch((error) => {
      throw error;
    })];
  } catch (error) {
    return [error, null];
  }
}

// node_modules/@mswjs/interceptors/lib/node/source-Bc2l3K3h.js
var __create2 = Object.create;
var __defProp2 = Object.defineProperty;
var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
var __getOwnPropNames2 = Object.getOwnPropertyNames;
var __getProtoOf2 = Object.getPrototypeOf;
var __hasOwnProp2 = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __copyProps2 = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames2(from), i = 0, n = keys.length, key; i < n; i++) {
    key = keys[i];
    if (!__hasOwnProp2.call(to, key) && key !== except) __defProp2(to, key, {
      get: ((k) => from[k]).bind(null, key),
      enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable
    });
  }
  return to;
};
var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create2(__getProtoOf2(mod)) : {}, __copyProps2(isNodeMode || !mod || !mod.__esModule ? __defProp2(target, "default", {
  value: mod,
  enumerable: true
}) : target, mod));
var requestContext = new AsyncLocalStorage2();
var logger2 = createLogger("http-request");
function forwardHttpEvents(options) {
  const controller = new AbortController();
  const { source, emitter, predicate, responsePredicate } = options;
  source.on("request", async (event) => {
    if (predicate(event.initiator)) {
      logger2.verbose('forwarding "request" event %o', { requestId: event.requestId });
      await emitter.emitAsPromise(event);
    }
  }, { signal: controller.signal });
  const responseListener = async (event) => {
    if (predicate(event.initiator) && (responsePredicate == null || responsePredicate(event))) {
      logger2.verbose('forwarding "response" event %o', {
        requestId: event.requestId,
        responseType: event.responseType
      });
      await emitter.emitAsPromise(event);
    }
  };
  const unhandledExceptionListener = async (event) => {
    if (predicate(event.initiator)) {
      logger2.verbose('forwarding "unhandledException" event %o', { requestId: event.requestId });
      await emitter.emitAsPromise(event);
    }
  };
  const addResponseListener = () => {
    if (!source.listeners("response").includes(responseListener)) source.on("response", responseListener, { signal: controller.signal });
  };
  const addUnhandledExceptionListener = () => {
    if (!source.listeners("unhandledException").includes(unhandledExceptionListener)) source.on("unhandledException", unhandledExceptionListener, { signal: controller.signal });
  };
  if (emitter.listenerCount("response") > 0) addResponseListener();
  if (emitter.listenerCount("unhandledException") > 0) addUnhandledExceptionListener();
  emitter.hooks.on("newListener", (type) => {
    if (type === "response") addResponseListener();
    if (type === "unhandledException") addUnhandledExceptionListener();
  }, {
    signal: controller.signal,
    persist: true
  });
  emitter.hooks.on("removeListener", (type) => {
    if (type === "response" && emitter.listenerCount("response") === 0) source.removeListener("response", responseListener);
    if (type === "unhandledException" && emitter.listenerCount("unhandledException") === 0) source.removeListener("unhandledException", unhandledExceptionListener);
  }, {
    signal: controller.signal,
    persist: true
  });
  return () => {
    controller.abort();
  };
}
var HttpRequestEvent = class extends TypedEvent {
  constructor(data) {
    super(...["request", {}]);
    this.request = data.request;
    this.requestId = data.requestId;
    this.initiator = data.initiator;
    this.controller = data.controller;
  }
};
var HttpResponseEvent = class extends TypedEvent {
  constructor(data) {
    super(...["response", {}]);
    this.response = data.response;
    this.responseType = data.responseType;
    this.request = data.request;
    this.requestId = data.requestId;
    this.initiator = data.initiator;
  }
};
var UnhandledHttpException = class extends TypedEvent {
  constructor(data) {
    super(...["unhandledException", {}]);
    this.error = data.error;
    this.request = data.request;
    this.requestId = data.requestId;
    this.initiator = data.initiator;
    this.controller = data.controller;
  }
};
function connectionOptionsToUrl(options, socket) {
  const isIPv6 = net2.isIPv6(options.host || "");
  const protocol = socket instanceof tls2.TLSSocket ? "https:" : getProtocolByConnectionOptions(options);
  const host = options.host || "localhost";
  const url = new URL(`${protocol}//${isIPv6 ? `[${host}]` : host}`);
  if (options.path) url.pathname = options.path;
  if (options.port) url.port = options.port.toString();
  if (options.auth) {
    const [username, password] = options.auth.split(":");
    url.username = encodeURIComponent(username);
    url.password = encodeURIComponent(password);
  }
  return url;
}
function getProtocolByConnectionOptions(options) {
  if (options.protocol) return options.protocol;
  if (options.port === 443) return "https:";
  return "http:";
}
var import_constants = /* @__PURE__ */ __toESM2((/* @__PURE__ */ __commonJSMin(((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.SPECIAL_HEADERS = exports.MINOR = exports.MAJOR = exports.QDTEXT = exports.CONNECTION_TOKEN_CHARS = exports.RELAXED_HEADER_CHARS = exports.HEADER_CHARS = exports.HTAB_SP_VCHAR_OBS_TEXT = exports.SP = exports.HTAB = exports.TOKEN = exports.HEX = exports.URL_CHAR = exports.USERINFO_CHARS = exports.MARK = exports.ALPHANUM = exports.DIGIT = exports.HEX_MAP = exports.NUM_MAP = exports.ALPHA = exports.METHODS = exports.METHODS_HTTP = exports.METHODS_HTTP2 = exports.METHODS_HTTP1 = exports.METHODS_RTSP = exports.METHODS_RAOP = exports.METHODS_AIRPLAY = exports.METHODS_ICECAST = exports.METHODS_NON_STANDARD = exports.METHODS_CALDAV = exports.METHODS_UPNP = exports.METHODS_SUBVERSION = exports.METHODS_WEBDAV = exports.METHODS_BASIC_HTTP = exports.METHODS_HTTP1_HEAD = exports.HEADER_STATE = exports.FINISH = exports.STATUSES = exports.LENIENT_FLAGS = exports.FLAGS = exports.TYPE = exports.ERROR = void 0;
  exports.ERROR = {
    OK: 0,
    INTERNAL: 1,
    STRICT: 2,
    CR_EXPECTED: 25,
    LF_EXPECTED: 3,
    UNEXPECTED_CONTENT_LENGTH: 4,
    UNEXPECTED_SPACE: 30,
    CLOSED_CONNECTION: 5,
    INVALID_METHOD: 6,
    INVALID_URL: 7,
    INVALID_CONSTANT: 8,
    INVALID_VERSION: 9,
    INVALID_HEADER_TOKEN: 10,
    INVALID_CONTENT_LENGTH: 11,
    INVALID_CHUNK_SIZE: 12,
    INVALID_STATUS: 13,
    INVALID_EOF_STATE: 14,
    INVALID_TRANSFER_ENCODING: 15,
    CB_MESSAGE_BEGIN: 16,
    CB_HEADERS_COMPLETE: 17,
    CB_MESSAGE_COMPLETE: 18,
    CB_CHUNK_HEADER: 19,
    CB_CHUNK_COMPLETE: 20,
    PAUSED: 21,
    PAUSED_UPGRADE: 22,
    PAUSED_H2_UPGRADE: 23,
    USER: 24,
    CB_URL_COMPLETE: 26,
    CB_STATUS_COMPLETE: 27,
    CB_METHOD_COMPLETE: 32,
    CB_VERSION_COMPLETE: 33,
    CB_HEADER_FIELD_COMPLETE: 28,
    CB_HEADER_VALUE_COMPLETE: 29,
    CB_CHUNK_EXTENSION_NAME_COMPLETE: 34,
    CB_CHUNK_EXTENSION_VALUE_COMPLETE: 35,
    CB_RESET: 31,
    CB_PROTOCOL_COMPLETE: 38
  };
  exports.TYPE = {
    BOTH: 0,
    REQUEST: 1,
    RESPONSE: 2
  };
  exports.FLAGS = {
    CONNECTION_KEEP_ALIVE: 1,
    CONNECTION_CLOSE: 2,
    CONNECTION_UPGRADE: 4,
    CHUNKED: 8,
    UPGRADE: 16,
    CONTENT_LENGTH: 32,
    SKIPBODY: 64,
    TRAILING: 128,
    TRANSFER_ENCODING: 512
  };
  exports.LENIENT_FLAGS = {
    HEADERS: 1,
    CHUNKED_LENGTH: 2,
    KEEP_ALIVE: 4,
    TRANSFER_ENCODING: 8,
    VERSION: 16,
    DATA_AFTER_CLOSE: 32,
    OPTIONAL_LF_AFTER_CR: 64,
    OPTIONAL_CRLF_AFTER_CHUNK: 128,
    OPTIONAL_CR_BEFORE_LF: 256,
    SPACES_AFTER_CHUNK_SIZE: 512,
    HEADER_VALUE_RELAXED: 1024
  };
  exports.STATUSES = {
    CONTINUE: 100,
    SWITCHING_PROTOCOLS: 101,
    PROCESSING: 102,
    EARLY_HINTS: 103,
    RESPONSE_IS_STALE: 110,
    REVALIDATION_FAILED: 111,
    DISCONNECTED_OPERATION: 112,
    HEURISTIC_EXPIRATION: 113,
    MISCELLANEOUS_WARNING: 199,
    OK: 200,
    CREATED: 201,
    ACCEPTED: 202,
    NON_AUTHORITATIVE_INFORMATION: 203,
    NO_CONTENT: 204,
    RESET_CONTENT: 205,
    PARTIAL_CONTENT: 206,
    MULTI_STATUS: 207,
    ALREADY_REPORTED: 208,
    TRANSFORMATION_APPLIED: 214,
    IM_USED: 226,
    MISCELLANEOUS_PERSISTENT_WARNING: 299,
    MULTIPLE_CHOICES: 300,
    MOVED_PERMANENTLY: 301,
    FOUND: 302,
    SEE_OTHER: 303,
    NOT_MODIFIED: 304,
    USE_PROXY: 305,
    SWITCH_PROXY: 306,
    TEMPORARY_REDIRECT: 307,
    PERMANENT_REDIRECT: 308,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    PAYMENT_REQUIRED: 402,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    NOT_ACCEPTABLE: 406,
    PROXY_AUTHENTICATION_REQUIRED: 407,
    REQUEST_TIMEOUT: 408,
    CONFLICT: 409,
    GONE: 410,
    LENGTH_REQUIRED: 411,
    PRECONDITION_FAILED: 412,
    PAYLOAD_TOO_LARGE: 413,
    URI_TOO_LONG: 414,
    UNSUPPORTED_MEDIA_TYPE: 415,
    RANGE_NOT_SATISFIABLE: 416,
    EXPECTATION_FAILED: 417,
    IM_A_TEAPOT: 418,
    PAGE_EXPIRED: 419,
    ENHANCE_YOUR_CALM: 420,
    MISDIRECTED_REQUEST: 421,
    UNPROCESSABLE_ENTITY: 422,
    LOCKED: 423,
    FAILED_DEPENDENCY: 424,
    TOO_EARLY: 425,
    UPGRADE_REQUIRED: 426,
    PRECONDITION_REQUIRED: 428,
    TOO_MANY_REQUESTS: 429,
    REQUEST_HEADER_FIELDS_TOO_LARGE_UNOFFICIAL: 430,
    REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
    LOGIN_TIMEOUT: 440,
    NO_RESPONSE: 444,
    RETRY_WITH: 449,
    BLOCKED_BY_PARENTAL_CONTROL: 450,
    UNAVAILABLE_FOR_LEGAL_REASONS: 451,
    CLIENT_CLOSED_LOAD_BALANCED_REQUEST: 460,
    INVALID_X_FORWARDED_FOR: 463,
    REQUEST_HEADER_TOO_LARGE: 494,
    SSL_CERTIFICATE_ERROR: 495,
    SSL_CERTIFICATE_REQUIRED: 496,
    HTTP_REQUEST_SENT_TO_HTTPS_PORT: 497,
    INVALID_TOKEN: 498,
    CLIENT_CLOSED_REQUEST: 499,
    INTERNAL_SERVER_ERROR: 500,
    NOT_IMPLEMENTED: 501,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
    HTTP_VERSION_NOT_SUPPORTED: 505,
    VARIANT_ALSO_NEGOTIATES: 506,
    INSUFFICIENT_STORAGE: 507,
    LOOP_DETECTED: 508,
    BANDWIDTH_LIMIT_EXCEEDED: 509,
    NOT_EXTENDED: 510,
    NETWORK_AUTHENTICATION_REQUIRED: 511,
    WEB_SERVER_UNKNOWN_ERROR: 520,
    WEB_SERVER_IS_DOWN: 521,
    CONNECTION_TIMEOUT: 522,
    ORIGIN_IS_UNREACHABLE: 523,
    TIMEOUT_OCCURED: 524,
    SSL_HANDSHAKE_FAILED: 525,
    INVALID_SSL_CERTIFICATE: 526,
    RAILGUN_ERROR: 527,
    SITE_IS_OVERLOADED: 529,
    SITE_IS_FROZEN: 530,
    IDENTITY_PROVIDER_AUTHENTICATION_ERROR: 561,
    NETWORK_READ_TIMEOUT: 598,
    NETWORK_CONNECT_TIMEOUT: 599
  };
  exports.FINISH = {
    SAFE: 0,
    SAFE_WITH_CB: 1,
    UNSAFE: 2
  };
  exports.HEADER_STATE = {
    GENERAL: 0,
    CONNECTION: 1,
    CONTENT_LENGTH: 2,
    TRANSFER_ENCODING: 3,
    UPGRADE: 4,
    CONNECTION_KEEP_ALIVE: 5,
    CONNECTION_CLOSE: 6,
    CONNECTION_UPGRADE: 7,
    TRANSFER_ENCODING_CHUNKED: 8
  };
  exports.METHODS_HTTP1_HEAD = { HEAD: 2 };
  exports.METHODS_BASIC_HTTP = {
    DELETE: 0,
    GET: 1,
    ...exports.METHODS_HTTP1_HEAD,
    POST: 3,
    PUT: 4,
    CONNECT: 5,
    OPTIONS: 6,
    TRACE: 7,
    /**
    * @see https://www.rfc-editor.org/rfc/rfc5789.html
    */
    PATCH: 28,
    LINK: 31,
    UNLINK: 32
  };
  exports.METHODS_WEBDAV = {
    COPY: 8,
    LOCK: 9,
    MKCOL: 10,
    MOVE: 11,
    PROPFIND: 12,
    PROPPATCH: 13,
    SEARCH: 14,
    UNLOCK: 15,
    BIND: 16,
    REBIND: 17,
    UNBIND: 18,
    ACL: 19
  };
  exports.METHODS_SUBVERSION = {
    REPORT: 20,
    MKACTIVITY: 21,
    CHECKOUT: 22,
    MERGE: 23
  };
  exports.METHODS_UPNP = {
    "M-SEARCH": 24,
    NOTIFY: 25,
    SUBSCRIBE: 26,
    UNSUBSCRIBE: 27
  };
  exports.METHODS_CALDAV = { MKCALENDAR: 30 };
  exports.METHODS_NON_STANDARD = {
    /**
    * Not defined in any RFC but commonly used
    */
    PURGE: 29,
    QUERY: 46
  };
  exports.METHODS_ICECAST = { SOURCE: 33 };
  exports.METHODS_AIRPLAY = {
    GET: 1,
    POST: 3
  };
  exports.METHODS_RAOP = { FLUSH: 45 };
  exports.METHODS_RTSP = {
    OPTIONS: exports.METHODS_BASIC_HTTP.OPTIONS,
    DESCRIBE: 35,
    ANNOUNCE: 36,
    SETUP: 37,
    PLAY: 38,
    PAUSE: 39,
    TEARDOWN: 40,
    GET_PARAMETER: 41,
    SET_PARAMETER: 42,
    REDIRECT: 43,
    RECORD: 44,
    ...exports.METHODS_AIRPLAY,
    ...exports.METHODS_RAOP
  };
  exports.METHODS_HTTP1 = {
    ...exports.METHODS_BASIC_HTTP,
    ...exports.METHODS_WEBDAV,
    ...exports.METHODS_SUBVERSION,
    ...exports.METHODS_UPNP,
    ...exports.METHODS_CALDAV,
    ...exports.METHODS_NON_STANDARD,
    ...exports.METHODS_ICECAST
  };
  exports.METHODS_HTTP2 = {
    /**
    * RFC-9113, section 11.6
    * @see https://www.rfc-editor.org/rfc/rfc9113.html#preface
    */
    PRI: 34
  };
  exports.METHODS_HTTP = {
    ...exports.METHODS_HTTP1,
    ...exports.METHODS_HTTP2
  };
  exports.METHODS = {
    ...exports.METHODS_HTTP1,
    ...exports.METHODS_HTTP2,
    ...exports.METHODS_RTSP
  };
  exports.ALPHA = [
    "A",
    "a",
    "B",
    "b",
    "C",
    "c",
    "D",
    "d",
    "E",
    "e",
    "F",
    "f",
    "G",
    "g",
    "H",
    "h",
    "I",
    "i",
    "J",
    "j",
    "K",
    "k",
    "L",
    "l",
    "M",
    "m",
    "N",
    "n",
    "O",
    "o",
    "P",
    "p",
    "Q",
    "q",
    "R",
    "r",
    "S",
    "s",
    "T",
    "t",
    "U",
    "u",
    "V",
    "v",
    "W",
    "w",
    "X",
    "x",
    "Y",
    "y",
    "Z",
    "z"
  ];
  exports.NUM_MAP = {
    0: 0,
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    6: 6,
    7: 7,
    8: 8,
    9: 9
  };
  exports.HEX_MAP = {
    0: 0,
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    6: 6,
    7: 7,
    8: 8,
    9: 9,
    A: 10,
    B: 11,
    C: 12,
    D: 13,
    E: 14,
    F: 15,
    a: 10,
    b: 11,
    c: 12,
    d: 13,
    e: 14,
    f: 15
  };
  exports.DIGIT = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9"
  ];
  exports.ALPHANUM = [...exports.ALPHA, ...exports.DIGIT];
  exports.MARK = [
    "-",
    "_",
    ".",
    "!",
    "~",
    "*",
    "'",
    "(",
    ")"
  ];
  exports.USERINFO_CHARS = [
    ...exports.ALPHANUM,
    ...exports.MARK,
    "%",
    ";",
    ":",
    "&",
    "=",
    "+",
    "$",
    ","
  ];
  exports.URL_CHAR = [
    "!",
    '"',
    "$",
    "%",
    "&",
    "'",
    "(",
    ")",
    "*",
    "+",
    ",",
    "-",
    ".",
    "/",
    ":",
    ";",
    "<",
    "=",
    ">",
    "@",
    "[",
    "\\",
    "]",
    "^",
    "_",
    "`",
    "{",
    "|",
    "}",
    "~",
    ...exports.ALPHANUM
  ];
  exports.HEX = [
    ...exports.DIGIT,
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "A",
    "B",
    "C",
    "D",
    "E",
    "F"
  ];
  exports.TOKEN = [
    "!",
    "#",
    "$",
    "%",
    "&",
    "'",
    "*",
    "+",
    "-",
    ".",
    "^",
    "_",
    "`",
    "|",
    "~",
    ...exports.ALPHANUM
  ];
  exports.HTAB = ["	"];
  exports.SP = [" "];
  const VCHAR = [
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    64,
    65,
    66,
    67,
    68,
    69,
    70,
    71,
    72,
    73,
    74,
    75,
    76,
    77,
    78,
    79,
    80,
    81,
    82,
    83,
    84,
    85,
    86,
    87,
    88,
    89,
    90,
    91,
    92,
    93,
    94,
    95,
    96,
    97,
    98,
    99,
    100,
    101,
    102,
    103,
    104,
    105,
    106,
    107,
    108,
    109,
    110,
    111,
    112,
    113,
    114,
    115,
    116,
    117,
    118,
    119,
    120,
    121,
    122,
    123,
    124,
    125,
    126
  ];
  const OBS_TEXT = [
    128,
    129,
    130,
    131,
    132,
    133,
    134,
    135,
    136,
    137,
    138,
    139,
    140,
    141,
    142,
    143,
    144,
    145,
    146,
    147,
    148,
    149,
    150,
    151,
    152,
    153,
    154,
    155,
    156,
    157,
    158,
    159,
    160,
    161,
    162,
    163,
    164,
    165,
    166,
    167,
    168,
    169,
    170,
    171,
    172,
    173,
    174,
    175,
    176,
    177,
    178,
    179,
    180,
    181,
    182,
    183,
    184,
    185,
    186,
    187,
    188,
    189,
    190,
    191,
    192,
    193,
    194,
    195,
    196,
    197,
    198,
    199,
    200,
    201,
    202,
    203,
    204,
    205,
    206,
    207,
    208,
    209,
    210,
    211,
    212,
    213,
    214,
    215,
    216,
    217,
    218,
    219,
    220,
    221,
    222,
    223,
    224,
    225,
    226,
    227,
    228,
    229,
    230,
    231,
    232,
    233,
    234,
    235,
    236,
    237,
    238,
    239,
    240,
    241,
    242,
    243,
    244,
    245,
    246,
    247,
    248,
    249,
    250,
    251,
    252,
    253,
    254,
    255
  ];
  exports.HTAB_SP_VCHAR_OBS_TEXT = [
    ...exports.HTAB,
    ...exports.SP,
    ...VCHAR,
    ...OBS_TEXT
  ];
  exports.HEADER_CHARS = exports.HTAB_SP_VCHAR_OBS_TEXT;
  exports.RELAXED_HEADER_CHARS = [...[
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    11,
    12,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    30,
    31,
    127
  ], ...exports.HEADER_CHARS];
  exports.CONNECTION_TOKEN_CHARS = [
    ...exports.HTAB,
    ...exports.SP,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    64,
    65,
    66,
    67,
    68,
    69,
    70,
    71,
    72,
    73,
    74,
    75,
    76,
    77,
    78,
    79,
    80,
    81,
    82,
    83,
    84,
    85,
    86,
    87,
    88,
    89,
    90,
    91,
    92,
    93,
    94,
    95,
    96,
    97,
    98,
    99,
    100,
    101,
    102,
    103,
    104,
    105,
    106,
    107,
    108,
    109,
    110,
    111,
    112,
    113,
    114,
    115,
    116,
    117,
    118,
    119,
    120,
    121,
    122,
    123,
    124,
    125,
    126,
    ...OBS_TEXT
  ];
  exports.QDTEXT = [
    ...exports.HTAB,
    ...exports.SP,
    33,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    64,
    65,
    66,
    67,
    68,
    69,
    70,
    71,
    72,
    73,
    74,
    75,
    76,
    77,
    78,
    79,
    80,
    81,
    82,
    83,
    84,
    85,
    86,
    87,
    88,
    89,
    90,
    91,
    93,
    94,
    95,
    96,
    97,
    98,
    99,
    100,
    101,
    102,
    103,
    104,
    105,
    106,
    107,
    108,
    109,
    110,
    111,
    112,
    113,
    114,
    115,
    116,
    117,
    118,
    119,
    120,
    121,
    122,
    123,
    124,
    125,
    126,
    ...OBS_TEXT
  ];
  exports.MAJOR = exports.NUM_MAP;
  exports.MINOR = exports.MAJOR;
  exports.SPECIAL_HEADERS = {
    "connection": exports.HEADER_STATE.CONNECTION,
    "content-length": exports.HEADER_STATE.CONTENT_LENGTH,
    "proxy-connection": exports.HEADER_STATE.CONNECTION,
    "transfer-encoding": exports.HEADER_STATE.TRANSFER_ENCODING,
    "upgrade": exports.HEADER_STATE.UPGRADE
  };
  exports.default = {
    ERROR: exports.ERROR,
    TYPE: exports.TYPE,
    FLAGS: exports.FLAGS,
    LENIENT_FLAGS: exports.LENIENT_FLAGS,
    STATUSES: exports.STATUSES,
    FINISH: exports.FINISH,
    HEADER_STATE: exports.HEADER_STATE,
    ALPHA: exports.ALPHA,
    NUM_MAP: exports.NUM_MAP,
    HEX_MAP: exports.HEX_MAP,
    DIGIT: exports.DIGIT,
    ALPHANUM: exports.ALPHANUM,
    MARK: exports.MARK,
    USERINFO_CHARS: exports.USERINFO_CHARS,
    URL_CHAR: exports.URL_CHAR,
    HEX: exports.HEX,
    TOKEN: exports.TOKEN,
    HEADER_CHARS: exports.HEADER_CHARS,
    RELAXED_HEADER_CHARS: exports.RELAXED_HEADER_CHARS,
    CONNECTION_TOKEN_CHARS: exports.CONNECTION_TOKEN_CHARS,
    QDTEXT: exports.QDTEXT,
    HTAB_SP_VCHAR_OBS_TEXT: exports.HTAB_SP_VCHAR_OBS_TEXT,
    MAJOR: exports.MAJOR,
    MINOR: exports.MINOR,
    SPECIAL_HEADERS: exports.SPECIAL_HEADERS,
    METHODS: exports.METHODS,
    METHODS_HTTP: exports.METHODS_HTTP,
    METHODS_HTTP1_HEAD: exports.METHODS_HTTP1_HEAD,
    METHODS_HTTP1: exports.METHODS_HTTP1,
    METHODS_HTTP2: exports.METHODS_HTTP2,
    METHODS_ICECAST: exports.METHODS_ICECAST,
    METHODS_RTSP: exports.METHODS_RTSP
  };
})))(), 1);
var KIND_REQUEST = import_constants.TYPE.REQUEST;
import_constants.TYPE.RESPONSE;
var kPointer = /* @__PURE__ */ Symbol("kPtr");
var kUrl2 = /* @__PURE__ */ Symbol("kUrl");
var kStatusMessage = /* @__PURE__ */ Symbol("kStatusMessage");
var kHeadersFields = /* @__PURE__ */ Symbol("kHeadersFields");
var kHeadersValues = /* @__PURE__ */ Symbol("kHeadersValues");
var kLastHeaderCallback = /* @__PURE__ */ Symbol("kLastHeaderCallback");
var kCallbacks = /* @__PURE__ */ Symbol("kCallbacks");
var kType = /* @__PURE__ */ Symbol("kType");
var HEADER_CB_NONE = 0;
var HEADER_CB_FIELD = 1;
var HEADER_CB_VALUE = 2;
var parsersMap = /* @__PURE__ */ new Map();
var methodNames = Object.fromEntries(Object.entries(import_constants.METHODS).map(([name, num]) => [num, name]));
function readStringFrom(pointer, length) {
  return Buffer.from(llhttp_memory.buffer, pointer, length).toString("latin1");
}
var wasmBaseUrl = import.meta.url;
var llhttpModule = new WebAssembly.Module(fs.readFileSync(new URL("./llhttp/llhttp.wasm", wasmBaseUrl)));
var llhttpInstance = new WebAssembly.Instance(llhttpModule, { env: {
  wasm_on_message_begin(parserPointer) {
    const parser = parsersMap.get(parserPointer);
    parser[kUrl2] = "";
    parser[kStatusMessage] = "";
    parser[kHeadersFields] = [];
    parser[kHeadersValues] = [];
    parser[kLastHeaderCallback] = HEADER_CB_NONE;
    return parser[kCallbacks].onMessageBegin?.() ?? 0;
  },
  wasm_on_url(parserPointer, at, length) {
    parsersMap.get(parserPointer)[kUrl2] = readStringFrom(at, length);
    return 0;
  },
  wasm_on_status(parserPointer, at, length) {
    parsersMap.get(parserPointer)[kStatusMessage] = readStringFrom(at, length);
    return 0;
  },
  wasm_on_header_field(parserPointer, at, length) {
    const parser = parsersMap.get(parserPointer);
    const chunk = readStringFrom(at, length);
    const fields = parser[kHeadersFields];
    if (parser[kLastHeaderCallback] === HEADER_CB_FIELD) fields[fields.length - 1] += chunk;
    else {
      fields.push(chunk);
      parser[kLastHeaderCallback] = HEADER_CB_FIELD;
    }
    return 0;
  },
  wasm_on_header_value(parserPointer, at, length) {
    const parser = parsersMap.get(parserPointer);
    const chunk = readStringFrom(at, length);
    const values = parser[kHeadersValues];
    if (parser[kLastHeaderCallback] === HEADER_CB_VALUE) values[values.length - 1] += chunk;
    else {
      values.push(chunk);
      parser[kLastHeaderCallback] = HEADER_CB_VALUE;
    }
    return 0;
  },
  wasm_on_headers_complete(parserPointer, statusCode, rawUpgrade, rawShouldKeepAlive) {
    const parser = parsersMap.get(parserPointer);
    const versionMajor = llhttp_get_version_major(parserPointer);
    const versionMinor = llhttp_get_version_minor(parserPointer);
    const rawHeaders = [];
    const upgrade = rawUpgrade === 1;
    const shouldKeepAlive = rawShouldKeepAlive === 1;
    for (let c = 0; c < parser[kHeadersFields].length; c++) rawHeaders.push(parser[kHeadersFields][c], parser[kHeadersValues][c]);
    if (parser[kType] === KIND_REQUEST) {
      const method = methodNames[llhttp_get_method(parserPointer)];
      const url = parser[kUrl2];
      return parser[kCallbacks].onHeadersComplete?.({
        versionMajor,
        versionMinor,
        rawHeaders,
        method,
        url,
        upgrade,
        shouldKeepAlive
      }) ?? 0;
    } else {
      const statusCode2 = llhttp_get_status_code(parserPointer);
      const statusMessage = parser[kStatusMessage];
      return parser[kCallbacks].onHeadersComplete?.({
        versionMajor,
        versionMinor,
        rawHeaders,
        statusCode: statusCode2,
        statusMessage,
        upgrade,
        shouldKeepAlive
      }) ?? 0;
    }
  },
  wasm_on_body(parserPointer, at, length) {
    const parser = parsersMap.get(parserPointer);
    const body = Buffer.from(new Uint8Array(llhttp_memory.buffer, at, length));
    return parser[kCallbacks].onBody?.(body) ?? 0;
  },
  wasm_on_message_complete(parserPointer) {
    return parsersMap.get(parserPointer)[kCallbacks].onMessageComplete?.() ?? 0;
  }
} });
var llhttp_memory = llhttpInstance.exports.memory;
var llhttp_alloc = llhttpInstance.exports.llhttp_alloc;
var llhttp_malloc = llhttpInstance.exports.malloc;
var llhttp_execute = llhttpInstance.exports.llhttp_execute;
llhttpInstance.exports.llhttp_get_type;
llhttpInstance.exports.llhttp_get_upgrade;
llhttpInstance.exports.llhttp_should_keep_alive;
var llhttp_get_method = llhttpInstance.exports.llhttp_get_method;
var llhttp_get_status_code = llhttpInstance.exports.llhttp_get_status_code;
var llhttp_get_version_minor = llhttpInstance.exports.llhttp_get_http_minor;
var llhttp_get_version_major = llhttpInstance.exports.llhttp_get_http_major;
var llhttp_get_error_reason = llhttpInstance.exports.llhttp_get_error_reason;
var llhttp_get_error_pos = llhttpInstance.exports.llhttp_get_error_pos;
var llhttp_free = llhttpInstance.exports.free;
var initialize = llhttpInstance.exports._initialize;
initialize();
var HttpParser = class {
  constructor(type, callbacks) {
    this[kUrl2] = "";
    this[kStatusMessage] = "";
    this[kHeadersFields] = [];
    this[kHeadersValues] = [];
    this[kLastHeaderCallback] = HEADER_CB_NONE;
    this[kType] = type;
    this[kCallbacks] = callbacks;
    const parserPointer = llhttp_alloc(type);
    if (parserPointer === 0) throw new Error("Failed to allocate llhttp parser");
    this[kPointer] = parserPointer;
    parsersMap.set(this[kPointer], this);
  }
  destroy() {
    if (this[kPointer] === 0) return;
    parsersMap.delete(this[kPointer]);
    llhttp_free(this[kPointer]);
    this[kPointer] = 0;
  }
  execute(data) {
    const pointer = llhttp_malloc(data.byteLength);
    if (pointer === 0) throw new Error("Failed to allocate llhttp input buffer");
    let ret;
    try {
      new Uint8Array(llhttp_memory.buffer).set(data, pointer);
      ret = llhttp_execute(this[kPointer], pointer, data.byteLength);
    } catch (error) {
      llhttp_free(pointer);
      throw error;
    }
    if (ret === import_constants.ERROR.PAUSED_UPGRADE) {
      const consumed = llhttp_get_error_pos(this[kPointer]) - pointer;
      llhttp_free(pointer);
      return data.subarray(consumed);
    }
    llhttp_free(pointer);
    this.#checkError(ret);
    return null;
  }
  #checkError(errorCode) {
    if (errorCode === import_constants.ERROR.OK) return;
    const errorPointer = llhttp_get_error_reason(this[kPointer]);
    const length = new Uint8Array(llhttp_memory.buffer).indexOf(0, errorPointer) - errorPointer;
    const error = new Error(readStringFrom(errorPointer, length));
    if (this[kCallbacks].onError) {
      this[kCallbacks].onError(error);
      return;
    }
    throw error;
  }
};
var HttpRequestParser = class extends HttpParser {
  #requestBodyStream;
  #upgrade = false;
  constructor(options) {
    super(1, {
      onError: options.onError,
      onHeadersComplete: ({ rawHeaders, method, url: path2, upgrade }) => {
        this.#upgrade = upgrade;
        const finalMethod = (method || options.connectionOptions.method || "GET").toUpperCase();
        const url = new URL(path2 || "", options.connectionOptions.url);
        const headers = FetchResponse.parseRawHeaders([...rawHeaders]);
        if (url.username || url.password) {
          if (!headers.has("authorization")) {
            const credentials = Buffer.from(`${url.username}:${url.password}`).toString("base64");
            headers.set("authorization", `Basic ${credentials}`);
          }
          url.username = "";
          url.password = "";
        }
        this.#requestBodyStream = new Readable({
          /**
          * @note Provide the `read()` method so a `Readable` could be
          * used as the actual request body (the stream calls "read()").
          */
          read: () => {
          }
        });
        const abortController = new AbortController();
        const request = new FetchRequest(url, {
          method: finalMethod,
          headers,
          credentials: "same-origin",
          body: Readable.toWeb(this.#requestBodyStream),
          signal: abortController.signal
        });
        options.onRequest(request, abortController);
      },
      onBody: (chunk) => {
        invariant(this.#requestBodyStream, "Failed to write to a request stream: stream does not exist. This is likely an issue with the library. Please report it on GitHub.");
        this.#requestBodyStream.push(chunk);
      },
      onMessageComplete: () => {
        this.#requestBodyStream?.push(null);
        this.#requestBodyStream = void 0;
        if (!this.#upgrade) options.onMessageComplete?.();
      }
    });
  }
  free(error) {
    this.destroy();
    this.#requestBodyStream?.destroy(error);
    this.#requestBodyStream = void 0;
  }
};
var HttpResponseParser = class extends HttpParser {
  #responseBodyStream;
  #status = 0;
  constructor(options) {
    super(2, {
      onError: options.onError,
      onHeadersComplete: ({ rawHeaders, statusCode: status, statusMessage: statusText }) => {
        this.#status = status;
        const headers = FetchResponse.parseRawHeaders([...rawHeaders]);
        const response = new FetchResponse(FetchResponse.isResponseWithBody(status) ? Readable.toWeb(this.#responseBodyStream = new Readable({ read() {
        } })) : null, {
          status,
          statusText,
          headers
        });
        options.onResponse(response);
      },
      onBody: (chunk) => {
        invariant(this.#responseBodyStream, "Failed to read from a response stream: stream does not exist. This is likely an issue with the library. Please report it on GitHub.");
        this.#responseBodyStream.push(chunk);
      },
      onMessageComplete: () => {
        this.#responseBodyStream?.push(null);
        this.#responseBodyStream = null;
        options.onMessageComplete?.(this.#status);
      }
    });
  }
  free(error) {
    this.destroy();
    if (error) this.#responseBodyStream?.destroy(error);
    this.#responseBodyStream = null;
  }
};
function isNodeLikeError(error) {
  if (error == null) return false;
  if (!(error instanceof Error)) return false;
  return "code" in error && "errno" in error;
}
async function handleRequest(options) {
  if (options.logger?.isEnabled("default")) formatRequest(options.request).then((message) => {
    options.logger?.info("[%s] %s", options.requestId, message);
  });
  const handleResponse = async (response) => {
    if (response instanceof Error) {
      await options.controller.errorWith(response);
      return true;
    }
    if (isResponseError(response)) {
      await options.controller.respondWith(response);
      return true;
    }
    if (isResponseLike(response)) {
      await options.controller.respondWith(response);
      return true;
    }
    if (isObject(response)) {
      await options.controller.errorWith(response);
      return true;
    }
    return false;
  };
  const handleResponseError = async (error) => {
    if (error instanceof InterceptorError) throw resultError;
    if (isNodeLikeError(error)) {
      await options.controller.errorWith(error);
      return true;
    }
    if (error instanceof Response) return await handleResponse(error);
    return false;
  };
  const requestAbortPromise = Promise.withResolvers();
  let requestAbortReason;
  let isRequestAborted = false;
  const onAbort = () => {
    isRequestAborted = true;
    requestAbortReason = options.request.signal?.reason;
    requestAbortPromise.reject(requestAbortReason);
  };
  if (options.request.signal) {
    if (options.request.signal.aborted) {
      await options.controller.errorWith(options.request.signal.reason);
      return;
    }
    options.request.signal.addEventListener("abort", onAbort, { once: true });
  }
  const [resultError] = await until(async () => {
    const requestEvent = new HttpRequestEvent({
      initiator: options.initiator,
      requestId: options.requestId,
      request: options.request,
      controller: options.controller
    });
    const requestListenersPromise = options.emitter.emitAsPromise(requestEvent);
    await Promise.race([
      requestAbortPromise.promise,
      requestListenersPromise,
      options.controller.handled
    ]);
    if (requestEvent.request !== options.request) options.request = requestEvent.request;
  });
  options.request.signal?.removeEventListener("abort", onAbort);
  if (isRequestAborted) {
    await options.controller.errorWith(requestAbortReason);
    return;
  }
  if (resultError) {
    if (await handleResponseError(resultError)) return;
    if (options.emitter.listenerCount("unhandledException") > 0) {
      const unhandledExceptionController = new RequestController(options.request, {
        /**
        * @note Intentionally empty passthrough handle.
        * This controller is created within another controller and we only need
        * to know if `unhandledException` listeners handled the request.
        */
        passthrough() {
        },
        async respondWith(response) {
          await handleResponse(response);
        },
        async errorWith(reason) {
          await options.controller.errorWith(reason);
        }
      });
      await options.emitter.emitAsPromise(new UnhandledHttpException({
        initiator: options.initiator,
        error: resultError,
        request: options.request,
        requestId: options.requestId,
        controller: unhandledExceptionController
      }));
      if (unhandledExceptionController.readyState !== RequestController.PENDING) return;
    }
    await options.controller.respondWith(createServerErrorResponse(resultError));
    return;
  }
  if (options.controller.readyState === RequestController.PENDING) return await options.controller.passthrough();
  return options.controller.handled;
}
function cloneResponse(response) {
  const clone = FetchResponse.clone(response);
  if (!response.body || !clone.body) return [response, clone];
  const observer = wrapResponse(clone);
  return [wrapResponse(response, observer.cancel).response, observer.response];
}
function wrapResponse(response, onCancel) {
  const body = response.body;
  const reader = body.getReader();
  const cancel = (reason) => {
    return body.locked ? reader.cancel(reason) : body.cancel(reason);
  };
  const wrappedResponse = new FetchResponse(new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      try {
        const cancellation = cancel(reason);
        if (onCancel) await Promise.all([cancellation, onCancel(reason)]);
        else cancellation.catch(() => {
        });
      } finally {
        reader.releaseLock();
      }
    }
  }, { highWaterMark: 0 }), response);
  copyRawHeaders(response.headers, wrappedResponse.headers);
  Object.defineProperties(wrappedResponse, {
    type: { value: response.type },
    redirected: { value: response.redirected }
  });
  return {
    response: wrappedResponse,
    cancel
  };
}
var httpLogger = createLogger("http-request");
var NodeHttpRequestSource = class extends Interceptor {
  static {
    this.symbol = /* @__PURE__ */ Symbol.for("node-http-request-source");
  }
  predicate() {
    return true;
  }
  setup() {
    const socketInterceptor = Interceptor.singleton(SocketInterceptor);
    socketInterceptor.apply(this);
    this.subscriptions.push(() => {
      socketInterceptor.dispose(this);
    });
    this.subscriptions.push(recordRawFetchHeaders());
    const controller = new AbortController();
    this.subscriptions.push(() => controller.abort());
    socketInterceptor.on("connection", ({ connectionOptions, socket, controller: socketController }) => {
      let isHttpConnection;
      let requestParser;
      let tunnelUrl;
      let abortPendingRequest;
      let pendingRequestController;
      const destroyIdleSocket = () => {
        if (pendingRequestController == null && socketController.readyState !== SocketController.PASSTHROUGH) socket.destroy();
      };
      controller.signal.addEventListener("abort", destroyIdleSocket);
      socket.once("close", () => {
        controller.signal.removeEventListener("abort", destroyIdleSocket);
      });
      const shouldPassthrough = () => {
        return socketController.readyState === SocketController.PENDING && !socket.destroyed;
      };
      const passthroughNonHttp = () => {
        setImmediate(() => {
          if (shouldPassthrough()) socketController.passthrough();
        });
      };
      const stopParsingRequests = (error) => {
        httpLogger.verbose("stopping HTTP request parsing: %o", error);
        isHttpConnection = false;
        if (pendingRequestController?.readyState === RequestController.PENDING) pendingRequestController.passthrough();
        else passthroughNonHttp();
        requestParser?.free(error);
      };
      const connectionRequestContext = requestContext.getStore();
      const rawSocket = socketController[kRawSocket];
      const realSocketDestroy = rawSocket._destroy.bind(rawSocket);
      rawSocket._destroy = (error, callback) => {
        abortPendingRequest?.();
        realSocketDestroy(error, callback);
      };
      const executeRequestParser = (parser, chunk) => {
        if (parser.execute(chunk) !== null) {
          socket.removeListener("data", onRequestData);
          parser.free();
          requestParser = void 0;
        }
      };
      const onRequestData = (chunk) => {
        if (isHttpConnection === false) {
          passthroughNonHttp();
          return;
        }
        if (tunnelUrl && !requestParser) {
          isHttpConnection = void 0;
          socketController.reset({
            host: tunnelUrl.hostname,
            port: Number(tunnelUrl.port) || 80,
            path: null
          });
        }
        if (requestParser) {
          executeRequestParser(requestParser, toBuffer(chunk));
          return;
        }
        const httpMessage = chunk.toString();
        const httpMethod = httpMessage.split(" ")[0] || "";
        if (!METHODS.includes(httpMethod.toUpperCase())) {
          isHttpConnection = false;
          passthroughNonHttp();
          return;
        }
        isHttpConnection = true;
        const baseUrl = tunnelUrl ?? connectionOptionsToUrl(connectionOptions, socket);
        httpLogger.verbose("handling http message %o", {
          httpMessage,
          httpMethod,
          baseUrl
        });
        const requestContextValue = requestContext.getStore() ?? connectionRequestContext;
        const initiator = requestContextValue?.initiator || socket;
        requestParser = new HttpRequestParser({
          onError: stopParsingRequests,
          connectionOptions: {
            method: httpMethod,
            url: baseUrl
          },
          /**
          * @note The message boundary ends the current exchange.
          * Schedule the controller reset so the next write on this
          * (kept-alive) socket opens a new exchange and buffers for
          * its own verdict instead of following the settled one
          * (e.g. leaking a mocked request to the server of a
          * previously passed-through exchange).
          */
          onMessageComplete: () => {
            socketController.scheduleReset();
          },
          onRequest: async (parsedRequest, requestAbortController) => {
            const request = requestContextValue?.transformRequest?.(parsedRequest) ?? parsedRequest;
            if (socketController["readyState"] !== SocketController.PENDING) socketController.reset();
            const requestId = createRequestId();
            const requestLogger = requestContextValue?.logger ?? httpLogger;
            httpLogger.verbose("received a parsed HTTP request %o", {
              method: request.method,
              url: request.url
            });
            const requestController = new RequestController(request, {
              respondWith: async (rawResponse) => {
                httpLogger.verbose("respondWith() %o", {
                  status: rawResponse.status,
                  statusText: rawResponse.statusText,
                  hasBody: rawResponse.body != null
                });
                if (socket.destroyed) return;
                socketController.claim();
                const originalResponse = FetchResponse.from(rawResponse, { url: request.url });
                const [response, responseClone] = !isResponseError(originalResponse) && this.emitter.listenerCount("response") > 0 ? cloneResponse(originalResponse) : [originalResponse, null];
                if (request.method === "CONNECT" && response.ok) {
                  tunnelUrl = new URL(`http://${request.url}`);
                  socket.on("data", onRequestData);
                }
                const respond = async () => {
                  await this.respondWith({
                    socket: socketController[kRawSocket],
                    request: context.request,
                    response
                  });
                  if (controller.signal.aborted) socket.end();
                };
                if (responseClone) await this.emitter.emitAsPromise(new HttpResponseEvent({
                  initiator,
                  requestId,
                  request: context.request,
                  response: responseClone,
                  responseType: "mock"
                }));
                if (socket.connecting) socket.once("connect", respond);
                else
                  await respond();
              },
              errorWith: (reason) => {
                if (reason instanceof Error) socket.destroy(reason);
              },
              passthrough: () => {
                const realSocket = socketController.passthrough(isHttpConnection === false ? void 0 : this.#modifyHttpHeaders(context.request));
                if (isHttpConnection === false) return;
                if (this.emitter.listenerCount("response") > 0) {
                  httpLogger.verbose('found "response" listener, corking socket reads');
                  socketController.corkReads();
                  let responseParserDisposed = false;
                  let responseComplete = false;
                  let hasFinalResponse = false;
                  const responseParser = new HttpResponseParser({
                    onError: (error) => {
                      disposeResponseParser(error);
                      socketController.uncorkReads();
                    },
                    onMessageComplete: (status) => {
                      responseComplete = status >= 200 || status === 101;
                    },
                    onResponse: async (response) => {
                      hasFinalResponse = response.status >= 200 || response.status === 101;
                      httpLogger.verbose("HTTP response parser parsed: %d %s", response.status, response.statusText);
                      if (isResponseError(response)) {
                        httpLogger.verbose("response is an error response, uncorking socket reads...");
                        socketController.uncorkReads();
                        return;
                      }
                      FetchResponse.setUrl(request.url, response);
                      try {
                        httpLogger.verbose('emitting "response" event');
                        await this.emitter.emitAsPromise(new HttpResponseEvent({
                          initiator,
                          requestId,
                          request: context.request,
                          response,
                          responseType: "original"
                        }));
                      } finally {
                        httpLogger.verbose("uncorking socket reads");
                        socketController.uncorkReads();
                        if (!responseParserDisposed && response.status < 200 && response.status !== 101) socketController.corkReads();
                      }
                    }
                  });
                  const onResponseData = (chunk2) => {
                    responseParser.execute(chunk2);
                    if (responseComplete) disposeResponseParser();
                  };
                  const onResponseEnd = () => {
                    disposeResponseParser();
                    if (!hasFinalResponse) socketController.uncorkReads();
                  };
                  const disposeResponseParser = (error) => {
                    responseParserDisposed = true;
                    realSocket.removeListener("data", onResponseData);
                    realSocket.removeListener("end", onResponseEnd);
                    realSocket.removeListener("close", onResponseEnd);
                    responseParser.free(error);
                  };
                  realSocket.on("data", onResponseData).once("end", onResponseEnd).once("close", onResponseEnd);
                }
              }
            }, {
              logger: requestLogger,
              requestId
            });
            invariant(socketController["readyState"] === SocketController.PENDING, "CANNOT HANDLE ALREADY HANDLED REQUEST", request.method, request.url, socketController["readyState"]);
            const context = {
              initiator,
              requestId,
              request,
              controller: requestController,
              emitter: this.emitter,
              logger: requestLogger
            };
            abortPendingRequest = () => {
              if (requestController.readyState === RequestController.PENDING) requestAbortController.abort();
            };
            pendingRequestController = requestController;
            try {
              await handleRequest(context);
            } finally {
              pendingRequestController = void 0;
              abortPendingRequest = void 0;
            }
          }
        });
        executeRequestParser(requestParser, toBuffer(chunk));
      };
      socket.on("data", onRequestData);
      socket.on("close", () => requestParser?.free());
      const onClientRead = (event) => {
        if (event !== "data" && event !== "readable") return;
        rawSocket.removeListener("newListener", onClientRead);
        setImmediate(() => {
          if (isHttpConnection === void 0 && shouldPassthrough()) socketController.passthrough();
        });
      };
      rawSocket.on("newListener", onClientRead);
      if (rawSocket.listenerCount("data") + rawSocket.listenerCount("readable") > 0) onClientRead("data");
    }, { signal: controller.signal });
  }
  async respondWith(args) {
    const { socket, request, response } = args;
    if (socket.destroyed) return;
    if (isResponseError(response)) {
      socket.destroy(Object.defineProperty(/* @__PURE__ */ new TypeError("Network error"), kErrorResponse, {
        value: response,
        enumerable: false
      }));
      return;
    }
    invariant(!socket.connecting, 'Failed to mock a response for "%s %s": socket has not connected', request.method, request.url);
    const incomingMessage = new IncomingMessage(socket);
    incomingMessage.method = request.method;
    const serverResponse = new ServerResponse(incomingMessage);
    const responseSocket = new net2.Socket();
    responseSocket._writeGeneric = (writev, data, encoding, callback) => {
      unwrapPendingData(data, (chunk, encoding2) => {
        socket.push(toBuffer(chunk), encoding2);
      });
      callback?.();
    };
    responseSocket._destroy = (error, callback) => {
      if (error) socket.destroy();
      callback(null);
    };
    responseSocket.on("drain", () => serverResponse.emit("drain"));
    serverResponse.assignSocket(responseSocket);
    serverResponse.removeHeader("connection");
    serverResponse.removeHeader("date");
    const rawResponseHeaders = getRawFetchHeaders(response.headers);
    serverResponse.writeHead(response.status, response.statusText || STATUS_CODES[response.status], rawResponseHeaders);
    socket._destroy = function(error, callback) {
      if (error)
        queueMicrotask(() => this.emit("error", error));
      callback(null);
      process.nextTick(() => this.emit("close", error != null));
    };
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            serverResponse.end();
            break;
          }
          if (!serverResponse.write(value)) await new Promise((resolve) => {
            serverResponse.once("drain", resolve);
          });
        }
      } catch {
        await new Promise((resolve) => process.nextTick(resolve));
        socket.destroy();
        return;
      }
    } else serverResponse.end();
    const isSelfDelimitingResponse = request.method === "HEAD" || response.headers.has("content-length") || response.headers.has("transfer-encoding") || !FetchResponse.isResponseWithBody(response.status);
    if (request.method === "CONNECT" && !response.ok || request.method !== "CONNECT" && !isSelfDelimitingResponse) {
      await new Promise((resolve) => process.nextTick(resolve));
      socket.push(null);
    }
  }
  #modifyHttpHeaders(request) {
    const transformRequestMessage = (httpMessage, encoding) => {
      if (encoding === "buffer") return httpMessage;
      const parts = httpMessage.toString(encoding).split("\r\n");
      const headersEndIndex = parts.findIndex((field) => field === "");
      const httpMessageHeaderPairs = parts.slice(1, headersEndIndex);
      const httpMessageRawHeaders = httpMessageHeaderPairs.map((line) => {
        const separatorIndex = line.indexOf(": ");
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 2)];
      });
      const requestRawHeaders = getRawFetchHeaders(request.headers);
      if (httpMessageRawHeaders.length === requestRawHeaders.length && httpMessageRawHeaders.every((tuple, index) => {
        const requestTuple = requestRawHeaders[index];
        return tuple[0] === requestTuple[0] && tuple[1] === requestTuple[1];
      })) return httpMessage;
      const httpMessageHeaders = FetchResponse.parseRawHeaders(httpMessageHeaderPairs.flatMap((header) => header.split(": ")));
      const visitedHeaders = /* @__PURE__ */ new Set();
      for (const [headerName] of requestRawHeaders) {
        const normalizedHeaderName = headerName.toLowerCase();
        if (visitedHeaders.has(normalizedHeaderName)) continue;
        visitedHeaders.add(normalizedHeaderName);
        const headerValue = request.headers.get(headerName);
        if (headerValue === null) continue;
        httpMessageHeaders.set(headerName, headerValue);
      }
      visitedHeaders.clear();
      const rawHeaderNames = new Set(requestRawHeaders.map(([headerName]) => headerName.toLowerCase()));
      for (const [headerName] of httpMessageRawHeaders) if (!rawHeaderNames.has(headerName.toLowerCase())) httpMessageHeaders.delete(headerName);
      const httpMessageHeadersString = Array.from(httpMessageHeaders).map(([name, value]) => `${name}: ${value}`).join("\r\n");
      parts.splice(1, headersEndIndex - 1, httpMessageHeadersString);
      return parts.join("\r\n");
    };
    return (pendingData, encoding, callback) => {
      if (Array.isArray(pendingData)) pendingData[0].chunk = transformRequestMessage(pendingData[0].chunk, pendingData[0].encoding);
      else pendingData = transformRequestMessage(pendingData, encoding);
      callback(pendingData);
    };
  }
};

// node_modules/@mswjs/interceptors/lib/node/interceptors/http/index.js
var HttpRequestInterceptor = class extends Interceptor {
  static {
    this.symbol = /* @__PURE__ */ Symbol.for("http-request-interceptor");
  }
  predicate() {
    return true;
  }
  setup() {
    const requestSource = Interceptor.singleton(NodeHttpRequestSource);
    requestSource.apply(this);
    this.subscriptions.push(() => {
      requestSource.dispose(this);
    });
    this.subscriptions.push(forwardHttpEvents({
      source: requestSource,
      emitter: this.emitter,
      predicate: () => {
        return true;
      }
    }));
  }
};

// packages/local-observer/index.mjs
import fs2 from "node:fs/promises";
import path from "node:path";

// packages/core/index.mjs
var SECRET_NAME = /(token|secret|password|authorization|cookie|api.?key|private.?key)/i;
var SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
function isSecretName(name) {
  return SECRET_NAME.test(String(name ?? ""));
}
function redactRecord(record = {}, headerMode = false) {
  const matcher = headerMode ? SECRET_HEADER : SECRET_NAME;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, matcher.test(key) ? "[REDACTED]" : value]));
}

// packages/local-observer/index.mjs
var MAX_CAPTURE_BYTES = 256e3;
function trafficCachePath(root2 = process.cwd()) {
  return path.join(path.resolve(root2), ".api-forge", "tmp", "traffic.ndjson");
}
function redactCapturedHeaders(headers = {}) {
  return redactRecord(Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")])), true);
}
function safeValue(value, key = "") {
  if (isSecretName(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => safeValue(entry));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, safeValue(entry, entryKey)]));
  return value;
}
function redactCapturedUrl(value) {
  try {
    const url = new URL(value);
    for (const [key] of url.searchParams) if (isSecretName(key)) url.searchParams.set(key, "[REDACTED]");
    return url.toString();
  } catch {
    return String(value ?? "");
  }
}
function redactCapturedQuery(entries = {}) {
  return safeValue(entries);
}
function parseCapturedBody(buffer, contentType = "") {
  if (!buffer?.length) return null;
  const text = Buffer.from(buffer).subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
  if (/json/i.test(contentType)) {
    try {
      return safeValue(JSON.parse(text));
    } catch {
    }
  }
  if (/application\/x-www-form-urlencoded/i.test(contentType)) return safeValue(Object.fromEntries(new URLSearchParams(text)));
  if (/multipart\/form-data/i.test(contentType)) return `[MULTIPART BODY OMITTED: ${buffer.length} bytes]`;
  if (/^(?:text\/|application\/(?:xml|javascript))/i.test(contentType)) {
    return text.replace(/\b(authorization|token|secret|password|passphrase|api.?key|cookie)\b\s*[:=]\s*([^\s&;,]+)/gi, "$1=[REDACTED]").replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  }
  return `[BINARY BODY OMITTED: ${buffer.length} bytes]`;
}
async function appendTraffic(root2, record) {
  const target = trafficCachePath(root2);
  await fs2.mkdir(path.dirname(target), { recursive: true, mode: 448 });
  try {
    const stats = await fs2.stat(target);
    if (stats.size >= 25e6) await fs2.rename(target, `${target}.1`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs2.appendFile(target, `${JSON.stringify({ version: 1, ...record })}
`, { mode: 384 });
  return target;
}

// scripts/aipi-observer-hook.mjs
var root = process.env.AIPI_OBSERVER_ROOT || process.cwd();
var observeAll = process.env.AIPI_OBSERVER_ALL === "true";
var allowedHosts = new Set((process.env.AIPI_OBSERVER_HOSTS || "localhost,127.0.0.1,::1").split(",").map((entry) => entry.trim()).filter(Boolean));
var pending = /* @__PURE__ */ new Map();
function isAllowed(url) {
  try {
    return observeAll || allowedHosts.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
async function capturedBody(message) {
  if (!message || ["GET", "HEAD"].includes(message.method)) return null;
  const declaredLength = Number(message.headers.get("content-length") || 0);
  if (declaredLength > 256e3) return `[BODY OMITTED: ${declaredLength} bytes]`;
  try {
    return parseCapturedBody(Buffer.from(await message.clone().arrayBuffer()), message.headers.get("content-type") || "");
  } catch {
    return "[UNAVAILABLE STREAM]";
  }
}
var interceptor = new HttpRequestInterceptor();
interceptor.on("request", async ({ request, requestId }) => {
  if (!isAllowed(request.url)) return;
  const url = new URL(request.url);
  pending.set(requestId, {
    startedAt: Date.now(),
    request: {
      method: request.method,
      url: redactCapturedUrl(request.url),
      route: url.pathname,
      query: redactCapturedQuery(Object.fromEntries(url.searchParams)),
      headers: redactCapturedHeaders(Object.fromEntries(request.headers)),
      body: await capturedBody(request)
    }
  });
});
interceptor.on("response", async ({ response, request, requestId }) => {
  if (!isAllowed(request.url)) return;
  const observed = pending.get(requestId) ?? {
    startedAt: Date.now(),
    request: { method: request.method, url: redactCapturedUrl(request.url), headers: redactCapturedHeaders(Object.fromEntries(request.headers)) }
  };
  pending.delete(requestId);
  await appendTraffic(root, {
    id: `traffic_${crypto.randomUUID().replaceAll("-", "")}`,
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    durationMs: Date.now() - observed.startedAt,
    source: "msw-http-interceptor",
    request: observed.request,
    response: {
      status: response.status,
      headers: redactCapturedHeaders(Object.fromEntries(response.headers)),
      body: await capturedBody(response)
    }
  });
});
interceptor.apply();
process.once("exit", () => interceptor.dispose());
