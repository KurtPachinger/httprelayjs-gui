/*jshint esversion: 6 */

sm = {
  proxy: "//demo.httprelay.io/proxy/" + uid,
  to: 10000,
  users: 2,
  log: {
    c: { uid: uid, auth: {}, users: 0 },
    [uid]: {
      c: { uid: uid, auth: {} },
      e: []
    }
  },
  SERVE: function () {
    // merge push with master, prune master, return revlist
    const proxy = new HttpRelay(new URL("https://demo.httprelay.io")).proxy(
      sm.log.c.uid
    );
    proxy.routes.addGet("/log", "log", (ctx) => {
      let log = JSON.parse(
        decodeURIComponent(ctx.request.url.searchParams.get("log"))
      );
      //console.log("log",log)

      // empty or malformed
      if (!log || !log.c.uid) {
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
              delete sm.log[cfg.uid].c.auth[user];
            }
          } else if (access == "allow") {
            cfg.users += 1;
          }
          cfg.auth[user] = access;
        }
        // access user
        if (user == uid) {
          auth = cfg.auth[user];
        }
        uac = auth != "allow";
        is_full = uac && cfg.users >= sm.users;
      };

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
          log.e[0].init = false;
          log.e[0].time = log.c.time = time;
          branch = sm.log[uid] = log;
        }
      }

      if (!init) {
        // push branch cfg to master
        Object.keys(log.c).forEach((meta) => {
          branch.c[meta] = log.c[meta];
        });
        // push branch events to master
        if (uid !== cfg.uid) {
          for (let i = 0; i < log.e.length; i++) {
            branch.e.push(log.e[i]);
          }
        }
      }

      // latency
      let delta = (time - branch.c.time) / cfg.users;
      delta = Math.max(1 - delta / sm.to, 0).toFixed(3);
      // events: prune server old, sent client new
      let revlist = { c: { time: time, hint: delta } };
      let users = 0;
      Object.keys(sm.log).forEach((key) => {
        if (key !== "c") {
          //console.log("master key", key);
          let user = sm.log[key];
          let u = (revlist[key] = { c: user.c });
          let block = cfg.auth[user.c.uid] == "deny";

          // enroll new uid to peers auth
          let auths = user.c.auth;
          if (init && key != uid) {
            auths[uid] = "init";
          }
          // peer events prior to init HEAD
          let auth = branch.c.auth[user.c.uid];
          let pull_hard = auth == "init";

          for (let i = user.e.length - 1; i >= 0; i--) {
            let event = user.e[i];
            // prune before HEAD (basic test)
            if (event.time < log.c.time) {
              for (let j = i - 1; j >= 1; j--) {
                let eventPre = user.e[j];
                if (event.id == eventPre.id && event.value == eventPre.value) {
                  user.e.splice(j, 1);
                  i--;
                }
              }
            }
            // commits to revlist, unless own user
            if (uid != user.c.uid) {
              let tip_push = event.time >= log.c.time - sm.to;
              let tip_pull = event.time >= user.c.time - sm.to;
              // auth new init local
              let HEAD = (tip_push || tip_pull) && event.time <= log.c.time;
              if ((HEAD && !block) || init || pull_hard) {
                u[event.time] = event;
              }
            }
          }
          // singleton full clone
          if (pull_hard) {
            delete branch.c.auth[user.c.uid];
          }

          // user access control
          const is_server = cfg.uid == user.c.uid;
          if (!is_server && (!block || sm.purge)) {
            // server as user skip: count, events, unload...
            let active = !!(user.e.length > 1);
            let recent = 60000 >= time - user.e[0].time;
            const is_unload = user.c.time == Infinity || (!active && !recent);
            if (is_unload) {
              // user access
              daemon("deny", user.c.uid);
            } else {
              users++;
            }
          }
        }
        // long-running code may try-catch or Promise
      });

      // real user count (not uac daemon)
      cfg.users = users;

      return revlist;
    });

    proxy.assets.addFetch("//codepen.io/kpachinger/pen/VwzmKJV.html", {
      name: "page",
      interpolate: true,
      mount: true
    });

    proxy.start();
  },
  GET: function (cfg) {
    let branch = sm.log[uid];
    let last = branch.c.time;
    // PUSH time to local HEAD per success code
    branch.c.time =
      isFinite(cfg.time) && cfg.hint >= 0
        ? Date.now()
        : branch.c.time || cfg.time;

    // push local cfg
    Object.keys(branch.c).forEach(function (k) {
      cfg[k] = branch.c[k];
    });

    // local user events since last GET
    let params = { c: cfg, e: [] };
    for (let i = branch.e.length - 1; i >= 0; i--) {
      let event = branch.e[i];
      if (event.time < last) {
        // event timestamps unique...?
        break;
      }
      params.e.unshift(event);
    }

    // todo: local user auth[] roles

    // route has 20-minute cache ( max 2048KB ~= 2MB )
    console.log("GET push:", params);
    params = encodeURIComponent(JSON.stringify(params));
    fetch(sm.proxy + "/log?log=" + params, {
      keepalive: true
    })
      .then((response) => {
        return response.text();
      })
      .then((data) => {
        return data ? JSON.parse(data) : {};
      })
      .then((revlist) => {
        console.log("GET pull", revlist);
        let cfg = revlist && revlist.c ? revlist.c : { hint: -1 };
        let revlogs = document.getElementById("revlist");
        let toast = document.createElement("article");
        revlogs.appendChild(toast);

        // cfg callback: error handling
        let status = "";
        if (cfg.hint === -1) {
          status += "access error";
          if (cfg.time == "Infinity") {
            //or 0?
            status += ": expired";
          } else if (cfg.time < 0) {
            // -Infinity or -queue
            status += ": max user" + cfg.time;
          }
          // undefined... reinit?
        }
        toast.innerText = status;

        // schedule GET
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
        toast.setAttribute("data-time", cfg.time || 0);
        let fragment = new DocumentFragment();
        Object.keys(revlist).forEach(function (key) {
          let merge = revlist[key];
          let card = document.createElement("section");
          if (key == "c") {
            if (!server && key.hint != -1) {
              // pull revlist cfg unless server or error
              //sm.log[key] = merge;
            }
            card.style.backgroundColor = "#efefef";
          } else {
            // user style
            let color = merge.color || (merge.c && merge.c.color) || "initial";
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
        toast.appendChild(fragment);
        toast.scrollIntoView();

        // revlist old remove
        let articles = revlogs.getElementsByTagName("article[data-time]");
        for (let i = articles.length - 1; i >= 0; i--) {
          let article = articles[i];
          let time = article.getAttribute("data-time");
          if (Date.now() - time > sm.to * 20) {
            article.parentElement.removeChild(article);
          }
        }
      });
  },
  proxy_init: function () {
    // share links
    document.querySelector("section.hide").classList.remove("hide");
    document.getElementById("logLink").setAttribute("href", sm.proxy + "/log");
    document
      .getElementById("pageLink")
      .setAttribute("href", sm.proxy + "/page");

    // proxy click type
    let proxy = server ? "server" : "client";
    document.getElementById(proxy).disabled = false;
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
          sm.SERVE();
          document.getElementById("client").disabled = false;
          document.querySelector("#sessions").classList.remove("hide");
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
          user.e.unshift({
            time: Date.now(),
            init: true
          });
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
  proxy_add: function (val, type) {
    if (type == "file") {
      var file = val.files[0];
      var reader = new FileReader();
      reader.onloadend = function () {
        console.log("FileReader:", reader.result);
        sm.proxy_add(reader.result);
      };
      file && reader.readAsDataURL(file);
    } else if (!type) {
      sm.log[uid].e.push({ time: Date.now(), value: val, id: 123 });
    } else {
      sm.log[uid].c[type] = val;
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
}
