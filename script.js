/*jshint esversion: 6 */
//lucid.app/documents/embeddedchart/e19ef36e-5abb-40fe-95d9-84cd4e140947#
const uid = Date.now();
const server = location.host.indexOf("httprelay") === -1;
console.log(window.location);

let sm = {
  proxy_url: "//demo.httprelay.io/proxy/" + uid,
  to: 2048 * 2,
  users: 2,
  log: {
    c: { uid: uid, auth: {}, users: 0 },
    [uid]: {
      c: { uid: uid },
      e: []
    }
  },
  SERVE: function () {
    // merge push with master, prune master, return revlist
    sm.proxy.routes.addGet("/log", "log", (ctx) => {
      let params = ctx.request.url.searchParams.get("log") || "{}";
      let log = JSON.parse(decodeURIComponent(params));
      console.log("log", log);

      // empty or malformed
      if (!log || !log.c || !log.c.uid) {
        return {};
      }

      // globals
      const time = Date.now();
      const uid = log.c.uid;
      let branch = sm.log[uid];
      let cfg = sm.log.c;

      // access user
      let init = log.e.length && log.e[0].init;
      let auth, uac, is_full;
      const daemon = function (access, user = uid) {
        // access server
        if (access) {
          // user with auth denied may retain session
          let branch = sm.log[user];
          if (access == "deny" && branch) {
            cfg.users -= 1;
            branch.c.time = "Infinity";
            branch.c.hint = 0;
            // prune user
            if (branch.e.length <= 1 || sm.purge) {
              delete sm.log[user];
              //delete cfg.auth[user];
            }
          } else if (access == "allow") {
            cfg.users += 1;
          }

          cfg.auth[user] = access;
        }
        // update access user, unless deny
        if (user == uid) {
          auth = cfg.auth[user];
        }
        uac = auth != "allow";
        is_full = uac && cfg.users >= sm.users;
      };

      // uac
      let unload = log.c.time == Infinity ? "deny" : false;
      daemon(unload);

      if (init || uac) {
        // user access control
        if (!auth) {
          // queue or allow
          let access = is_full ? log.e[0].time : "allow";
          daemon(access);
        } else if (isFinite(auth) && !is_full) {
          // allow oldest queuer
          let initiate = uid;
          Object.keys(cfg.auth).forEach(function (user) {
            let depth = cfg.auth[user];
            if (isFinite(depth) && depth < cfg.auth[initiate]) {
              initiate = user;
            }
          });
          daemon("allow", initiate);
          //console.log("allow from queue", uid);
        }

        // abort, no permission
        if (uac || is_full) {
          //log.e = [];
          const queue = function () {
            // queuer timestamp depth
            let wait = 0;
            Object.keys(cfg.auth).forEach(function (user) {
              let depth = cfg.auth[user];
              if (isFinite(depth) && depth <= auth) {
                wait++;
              }
            });
            return -wait;
          };
          let wait = auth == "deny" ? "Infinity" : queue();
          return { c: { time: wait, hint: -1 } };
        } else if (init) {
          // new master branch, bump access time
          log.e[0].time = log.c.time = time;
          branch = sm.log[uid] = log;
          branch.c.auth = {};
        }
      }

      let events = branch.e;
      // last fetch ( multi-part 0 ) minus one deviation
      let tip_sort = branch.c.time - sm.to;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].time < tip_sort) {
          // index to sort multi-part timestamps
          tip_sort = i;
          break;
        }
      }

      // push log events to master branch
      if (!init && uid !== cfg.uid) {
        for (let i = 0; i < log.e.length; i++) {
          events.push(log.e[i]);
        }
      }

      // sort events by time
      function multipart(a, b) {
        if ("init" in a || "init" in b) {
          return 0;
        } else {
          if (a.time < b.time) return -1;
          if (a.time > b.time) return 1;
          return 0;
        }
      }
      let sorted = events.slice(tip_sort).sort(multipart);
      branch.e = events.slice(0, tip_sort).concat(sorted);

      // multi-part early abort. should uac/daemon?
      if (log.c.hint > 1) {
        return { c: { time: "Infinity", hint: log.c.hint } };
      }

      // push branch cfg to master
      Object.keys(log.c).forEach((meta) => {
        if (init || (meta != "time" && meta != "auth")) {
          // && meta != hint ??
          branch.c[meta] = log.c[meta];
        }
      });

      // latency
      // server: [...AIMD poll intervals] (revlists use -interval)
      // client: compression factor
      let delta = (time - log.c.time) / sm.to;
      delta = branch.c.hint = Math.max(1 - delta, 0).toFixed(3);
      // events: prune server old, sent client new
      let revlist = { c: { time: time, hint: delta } };
      let users = 0;

      Object.keys(sm.log).forEach((peer) => {
        // node, peer, meta
        if (peer !== "c") {
          //console.log("master key", key);
          let user = sm.log[peer];
          let u = (revlist[peer] = { c: user.c });
          let block = cfg.auth[peer] == "deny";

          // peers init, round-trip, events
          let pull_hard =
            branch.c.auth[peer] === "init" &&
            branch.e[0].init === false &&
            user.e[0].init === false &&
            user.e.length > 1;

          for (let i = user.e.length - 1; i >= 0; i--) {
            let event = user.e[i];
            //
            // if(!pull_hard && event.time)
            //

            // commits to revlist, unless own user
            if (uid != peer) {
              let tip_push = event.time >= branch.c.time - sm.to;
              let tip_pull = event.time >= user.c.time - sm.to;
              // auth new init local
              let HEAD = (tip_push || tip_pull) && event.time <= time;
              if ((HEAD && !block) || pull_hard) {
                // || init
                u[event.time] = event;
              }
            }
            // prune before HEAD (basic test)
            if (event.time < branch.c.time) {
              for (let j = i - 1; j >= 0; j--) {
                let eventPre = user.e[j];
                if (event.id == eventPre.id && event.value == eventPre.value) {
                  user.e.splice(j, 1);
                  i--;
                }
              }
            }
          }

          // peer init, full clone singleton
          if (pull_hard) {
            branch.c.auth[peer] = "done";
            //delete branch.c.auth[peer];
          }
          // peer init, handshake
          if (user.c.auth && !user.c.auth[uid] && !block && uid != peer) {
            user.c.auth[uid] = "init";
          }

          // user access control
          const is_server = cfg.uid == peer;
          if (!is_server && (!block || sm.purge)) {
            // server as user skip: count, events, unload...
            let active = !!(user.e.length > 1);
            let recent = 60000 >= time - user.e[0].time;
            const is_unload = user.c.time == Infinity || (!active && !recent);
            if (is_unload) {
              // user access
              // deny peer or user.c.uid
              daemon("deny", user.c.uid);
            } else {
              users++;
            }
          }
          // client revlist doesn't use auth...?
          //u.c.auth = {};
        }
        // async...?
      });

      // real meta (not uac daemon, pre-revlist)
      cfg.users = users;
      branch.c.time = log.c.time;

      // server/user auth handshake
      if (init) {
        log.e[0].init = false;
      }

      return revlist;
    });
  },
  GET: function (cfg) {
    let branch = sm.log[uid];
    let last = branch.c.time;

    // local HEAD time per response hint
    branch.c.time =
      isFinite(cfg.time) && cfg.hint >= 0
        ? Date.now()
        : branch.c.time || cfg.time;

    // init event
    let auth = branch.e[0];
    if (!isFinite(last) && isFinite(branch.c.time)) {
      // final handshake could utilize cfg.hint 1.000 >= 0
      auth.init = false;
      auth.time = cfg.time;
    }

    // if URL parameter exceeds boundary, multi-part fetch (like FormData)
    const body = function (boundary) {
      // push local cfg
      let params = { c: {}, e: [] };
      Object.keys(branch.c).forEach(function (k) {
        // multi-part cfg is minimal
        if (boundary === 0 || k == "uid" || k == "time" || k == "hint") {
          params.c[k] = branch.c[k];
        }
      });
      // multi-part fetch returns revlist once
      params.c.hint = boundary + 1;
      return params;
    };
    let multi = [body(0)];
    let part = multi[multi.length - 1];

    // proxy parameters
    if (auth.init) {
      // uac daemon
      part.e.unshift(auth);
    } else {
      // local user events since last GET
      for (let i = branch.e.length - 1; i >= 0; i--) {
        let event = branch.e[i];
        if (event.time > last) {
          if (JSON.stringify(part).length >= 20480) {
            let boundary = multi.length;
            part = multi[boundary] = body(boundary);
          }
          // init sends false once more
          part.e.unshift(event);
        } else {
          break;
        }
      }
    }

    // route has 20-minute cache ( max ~2048KB )
    let revlogs = document.getElementById("revlist");
    const RPS = 5;
    for (let i = 0; i < multi.length; i++) {
      // requests per second, distributed through 100ms
      let toRPS = 1000 * Math.floor(i / RPS);
      toRPS += (i / RPS) * 100;

      setTimeout(() => {
        console.log("multipart", multi[i]);
        let toast = document.createElement("article");
        let status = "";
        let part = encodeURIComponent(JSON.stringify(multi[i]));
        fetch(sm.proxy_url + "/log?log=" + part, { keepalive: true })
          .then((response) => {

            if (!response.ok || response.status === 401) {
              // error, reconnect?
              document.getElementById("client").disabled = false;
              status = "server error: " + response.status;
              throw new Error(response.status);
            }

            return response.text();
          })
          .then((data) => {
            //return data ? JSON.parse(data) : {};
            return JSON.parse(data);
          })
          .then((revlist) => {
            // max revlist: ~2048KB*users
            console.log("revlist", revlist);

            let cfg = revlist && revlist.c ? revlist.c : { hint: -1 };

            // cfg callback: uac daemon
            if (cfg.hint === -1) {
              status += "access error";
              if (cfg.time == "Infinity") {
                // uid blocked, reconnect?
                document.getElementById("client").disabled = false;
                status += ": expired";
              } else if (cfg.time < 0) {
                // -Infinity or -queue
                status += ": max user" + cfg.time;
              }
              // undefined... reconnect?
            } else if (cfg.hint > 1 && cfg.time == "Infinity") {
              status = "multi-part: " + cfg.hint;
              return;
            }

            // reconnect loop
            clearTimeout(sm.sto);
            if (cfg.time != "Infinity") {
              sm.sto = setTimeout(function () {
                sm.GET(cfg);
              }, sm.to);
            }

            // local logs
            document.getElementById("local").innerText = JSON.stringify(
              sm.log,
              null,
              2
            );

            // revlist cards
            let fragment = new DocumentFragment();
            Object.keys(revlist).forEach(function (key) {
              let merge = revlist[key];
              let card = document.createElement("section");
              if (key == "c") {
                if (!server) {
                  // pull revlist cfg unless server or error
                  sm.log[key].hint = merge.hint;
                }
                card.style.backgroundColor = "#efefef";
              } else {
                // user style
                let color =
                  merge.color || (merge.c && merge.c.color) || "initial";
                card.style.backgroundColor = color;
                // text legible
                color = color.replace("#", "").replace("initial", "FFFFFF");
                color =
                  Number(color.charAt(0)) +
                  Number(color.charAt(2)) +
                  Number(color.charAt(4));
                if (isFinite(color) && color <= 27) {
                  card.style.color = "#fff";
                }
                // latency
                let hint = (90 * (merge.c && merge.c.hint)) | 0;
                hint = "hsl(" + hint + ", 100%, 50%)";
                card.style.boxShadow = "inset 0.25rem 0 " + hint;
              }
              // prettify
              let string = JSON.stringify({ [key]: merge }, null, 2);
              string = string.slice(1);
              string = string.slice(0, -1);
              card.innerText = string;
              // output
              fragment.append(card);
            });
            toast.append(fragment);

            // revlist old remove
            let articles = revlogs.querySelectorAll("article[data-time]");
            for (let i = articles.length - 1; i >= 0; i--) {
              let article = articles[i];
              let time = article.getAttribute("data-time");
              if (Date.now() - time > sm.to * 20) {
                article.parentElement.removeChild(article);
              }
            }
          })
          .catch((error) => {
            console.error("GET error", error);
          })
          .finally(() => {
            // output toast ui
            toast.setAttribute("data-time", Date.now());
            toast.prepend(status);
            revlogs.appendChild(toast);
            toast.scrollIntoView();
          });
      }, toRPS);
    }
  },
  proxy_init: function () {
    // proto template served to client
    let template = document.getElementById("template").cloneNode(true);

    // proxy role
    let role = server ? "server" : "client";
    document.getElementById(role).disabled = false;

    // share links
    document.getElementById("logs").classList.remove("hide");
    document
      .getElementById("logLink")
      .setAttribute("href", sm.proxy_url + "/log");
    document
      .getElementById("pageLink")
      .setAttribute("href", sm.proxy_url + "/page");

    if (server) {
      // create name server
      sm.proxy = new HttpRelay(new URL("https://demo.httprelay.io")).proxy(
        sm.log.c.uid
      );
      // dependency
      let serverId = document.createElement("script");
      serverId.textContent = "const serverId = " + sm.log.c.uid;
      let js = document.createElement("script");
      js.src = "//codepen.io/kpachinger/pen/VwzmKJV.js";
      
      sm.proxy.routes.addGet("/page", "page", () => {
        // route clients to landing page
        let doc = document.implementation.createHTMLDocument(
          "HTTPRelay-js Client"
        );
        doc.head.appendChild(serverId);
        doc.body.appendChild(template);
        doc.body.appendChild(js);
        return doc;
      });

      sm.proxy.start();
    }

    // click events
    let ui = document.querySelectorAll("fieldset [id]");
    for (let i = ui.length - 1; i >= 0; i--) {
      let el = ui[i];
      switch (el.id) {
        case "client":
        case "server":
          el.addEventListener("click", button);
          break;
        default:
          el.addEventListener("change", button);
      }
    }

    function button(e) {
      let target = e.target,
        id = target.id;
      if (id == "server" || id == "client") {
        target.disabled = true;
        if (id == "server") {
          // route client event logs
          sm.SERVE();
          document.getElementById("client").disabled = false;
          document.getElementById("sessions").classList.remove("hide");
        } else {
          // vanity username
          let user = sm.log[uid];
          const rand = function (arr) {
            return arr[Math.floor(Math.random() * arr.length)];
          };
          if (!user.c.user) {
            let username = "HOST";
            if (!server) {
              username = ["Delta", "Gamma", "Vega", "Theta"];
              username = rand(username);
              username += "_" + Math.floor(Math.random() * 100);
            }
            user.c.user = username;
            document.getElementById("user").value = username;
          }
          if (!user.c.color) {
            let color = "#c0c0c0";
            if (!server) {
              color = ["c0", "cf", "ff"];
              color = "#" + rand(color) + rand(color) + rand(color);
            }
            user.c.color = color;
            document.getElementById("color").value = color;
          }

          // init event and GET loop
          if (!user.e.length) {
            user.e.unshift({
              time: Date.now(),
              init: true
            });
          } else {
            // button re-enabled (no server, timeout...)

            if (!server && user.e[0].init != true) {
              // attempt reconnect with convoluted uid
              user.c.uid += "r";
              user.e[0].init = true;
              user.c.time = "-Infinity";
            }
          }
          sm.GET({ time: "-Infinity" });
        }
      } else {
        switch (id) {
          case "users":
            // users may only increase
            if (target.value > sm.users) {
              sm[id]++;
            } else {
              target.value = sm.users;
            }
            break;
          default:
            sm[id] = target.checked;
        }
      }
    }
  },
  proxy_add: function (val, type, id = 123) {
    if (type == "file") {
      let files = val.files;
      if (FileReader && files && files.length) {
        for (let i = 0; i < files.length; i++) {
          let file = files[i];
          let fr = new FileReader();
          fr.onload = function () {
            let img = document.createElement("img");
            img.onload = function () {
              let canvas = sm.fileMax(img);
              //let imgMax = document.createElement("img");
              let compress = canvas.toDataURL("image/jpeg", 0.5);
              // add
              let en = sm.lzw.en(compress);
              sm.proxy_add(en, false, encodeURI(file.name));
            };
            console.log("FileReader:", fr.result);
            img.src = fr.result;
          };
          fr.readAsDataURL(file);
        }
      }
    } else if (!type) {
      sm.log[uid].e.push({ time: Date.now(), value: val, id: id });
    } else {
      sm.log[uid].c[type] = val;
    }
  },
  fileMax: function (img) {
    var MAX = 256;

    var width = img.width;
    var height = img.height;

    // Change the resizing logic
    if (width > height) {
      if (width > MAX) {
        height = height * (MAX / width);
        width = MAX;
      }
    } else {
      if (height > MAX) {
        width = width * (MAX / height);
        height = MAX;
      }
    }

    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);

    return canvas;
  },
  lzw: {
    en: function (c) {
      var x = "charCodeAt",
        b,
        e = {},
        f = c.split(""),
        d = [],
        a = f[0],
        g = 256;
      for (b = 1; b < f.length; b++)
        (c = f[b]),
          null != e[a + c]
            ? (a += c)
            : (d.push(1 < a.length ? e[a] : a[x](0)),
              (e[a + c] = g),
              g++,
              (a = c));
      d.push(1 < a.length ? e[a] : a[x](0));
      for (b = 0; b < d.length; b++) d[b] = String.fromCharCode(d[b]);
      return d.join("");
    },
    de: function (b) {
      let f, o;
      var a,
        e = {},
        d = b.split(""),
        c = (f = d[0]),
        g = [c],
        h = (o = 256);
      for (b = 1; b < d.length; b++)
        (a = d[b].charCodeAt(0)),
          (a = h > a ? d[b] : e[a] ? e[a] : f + c),
          g.push(a),
          (c = a.charAt(0)),
          (e[o] = f + c),
          o++,
          (f = a);
      return g.join("");
    }
  }
};

if (server) {
  // server: load proxy & SERVE
  let script = document.createElement("script");
  script.src = "//unpkg.com/httprelay@0.0.44/lib/non-mod/httprelay.js";
  script.onload = function () {
    sm.proxy_init();
  };
  document.head.appendChild(script);
} else {
  console.log("CLIENT");
  // client: load proxy & GET
  sm.log.c.uid = serverId;
  sm.proxy_url = "https://demo.httprelay.io/proxy/" + sm.log.c.uid;
  sm.proxy_init();
  window.onbeforeunload = function () {
    // unload stricter
    sm.log[uid].c.time = "Infinity";
    sm.GET({
      time: "Infinity"
    });
  };
}
