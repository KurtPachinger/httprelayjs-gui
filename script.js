sm = {
  proxy: "//demo.httprelay.io/proxy/" + uid,
  to: 2500,
  gets: 2,
  log: {
    c: { uid: uid, time: -Infinity, bak: [] },
    [uid]: {
      c: { uid: uid },
      e: []
    }
  },
  SERVE: function () {
    // register endpoint
    const proxy = new HttpRelay(new URL("https://demo.httprelay.io")).proxy(
      sm.log.c.uid
    );
    proxy.routes.addGet("/log", "log", (ctx) => {
      // ...coerce invalid JSON to Number("NaN")
      let log = JSON.parse(
        decodeURIComponent(ctx.request.url.searchParams.get("log"))
      );
      //console.log("log",log)

      // empty or malformed
      if (!log || !log.c.uid) {
        return {};
      }

      // globals
      let uid = sm.log[log.c.uid];
      let cfg = sm.log.c;
      cfg.time = Date.now();
      const blocked = cfg.bak.indexOf(log.c.uid) !== -1;

      // sm.gets may increase but NOT decrease
      let is_full =
        cfg.gets >= sm.gets && log.e[0] && log.e[0].value == "connect";

      if (uid === undefined || !log.e.length || is_full) {
        // new uid needs master branch
        // or uid blocked
        // or new user had no connect event
        let branch = { c: { uid: log.c.uid, hint: -1 }, e: [] };
        if (blocked || (uid === undefined && !log.e.length) || is_full) {
          // return error status to user (improper, blocked, full)
          console.log("user denied");
          // error code if user
          if (is_full) {
            branch.c.time = "-Infinity";
          }
          return branch;
        } else if (uid === undefined && log.e.length) {
          // new master branch
          uid = sm.log[log.c.uid] = branch;
        }
      }

      // log meta to master branch
      Object.keys(log.c).forEach((cfg) => {
        if (cfg !== "uid") {
          uid.c[cfg] = log.c[cfg];
        }
      });
      // log events to master branch
      if (log.c.uid !== cfg.uid) {
        for (let i = 0; i < log.e.length; i++) {
          uid.e.push(log.e[i]);
        }
      }

      // prune server old, sent client new
      let revlist = { c: { time: cfg.time } };
      let g = 0;
      Object.keys(sm.log).forEach((key) => {
        if (key !== "c") {
          //console.log("master key", key);

          let user = sm.log[key];

          let u = (revlist[key] = { c: user.c });
          for (let i = user.e.length - 1; i >= 0; i--) {
            // user events
            let eventCurr = user.e[i];
            if (eventCurr.time < log.c.time) {
              // time before head
              for (let j = i - 1; j >= 1; j--) {
                // prune, blacklist, etc.
                let eventPrev = user.e[j];
                if (
                  eventCurr.id == eventPrev.id &&
                  eventCurr.value == eventPrev.value
                ) {
                  user.e.splice(j, 1);
                  i--;
                }
              }
            }
            // revlist: get updates since last
            // event times after group "head" was flawed approach
            // time interval pushback is better
            // ...but interval variance leaves gaps
            let last_this = eventCurr.time >= log.c.time - sm.to;
            let last_that = eventCurr.time >= user.c.time - sm.to;
            let last = (last_this || last_that) && eventCurr.time <= log.c.time;
            if (uid.c.hint == -1 || user.c.hint == -1 || last) {
              // new user(s) or events since last
              if (!blocked && log.c.uid != user.c.uid) {
                // commits to revlist, unless own user
                u[eventCurr.time] = eventCurr;
              }
            }
          }

          let block = cfg.bak.indexOf(user.c.uid) !== -1;
          if (!block || sm.purge) {
            // users session criterion to reduce zombies
            const is_server = cfg.uid == user.c.uid;
            let active = !!(user.e.length > 1 || user.c.user);
            let recent = 120000 >= cfg.time - user.e[0].time;
            const is_unload = user.c.hint == Infinity || (!active && !recent);

            if (!is_server && is_unload) {
              // prune users
              !block && cfg.bak.push(user.c.uid);
              if (user.e.length <= 1 || sm.purge) {
                // prune _empty_ backlog
                delete sm.log[user.c.uid];
              }
            } else {
              // audit users
              g++;
            }
          }
        }
      });

      // users active
      cfg.gets = g;
      // timestamp log to master branch
      uid.c.time = log.c.time;

      // user latency
      let deltaUser = (cfg.time - uid.c.time) / g;
      deltaUser = Math.max(1 - deltaUser / sm.to, 0);
      uid.c.hint = uid.c.hint == Infinity ? 0 : deltaUser;
      // note: timestamp of server as client is more current than updates

      return revlist;
    });
    proxy.assets.addFetch("//codepen.io/kpachinger/pen/VwzmKJV.html", {
      name: "page",
      interpolate: true,
      mount: true
    });

    // start server
    proxy.start();
  },
  GET: function (cfg) {
    // consume endpoint, push branch
    let branch = sm.log[uid];
    let last = branch.c.time || -Infinity;

    if (cfg && cfg.hint === -1) {
      // critical event
      branch.c.time = "-Infinity";
    } else {
      // time for reverse-parse and latency
      branch.c.time = Date.now();
    }
    branch.c.hint = cfg === Infinity ? "Infinity" : 0;

    // local user events since last GET
    let params = { c: branch.c, e: [] };
    for (let i = branch.e.length - 1; i >= 0; i--) {
      let event = branch.e[i];
      if (event.time < last) {
        // event timestamps unique...?
        break;
      }
      params.e.unshift(event);
    }

    // route has 20-minute cache ( max 2048KB ~= 2MB )
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
      .then((response) => {
        console.log("revlist", response);
        clearTimeout(sm.sto);
        let revlist = response;
        let cfg = revlist && revlist.c ? revlist.c : null;
        let revlogs = document.getElementById("revlist");
        let toast = document.createElement("article");
        revlogs.appendChild(toast);

        // cfg callback: error handling
        if (!cfg || cfg.hint === -1) {
          if (cfg.time == -Infinity) {
            toast.innerText = "error: session users max";
          } else {
            // error fatal
            toast.innerText = "error: session expired";
            return;
          }
        } else {
          sm.log[uid].c.time = cfg.time;
        }

        // schedule GET
        sm.sto = setTimeout(function () {
          sm.GET(cfg);
        }, sm.to);

        // local logs
        document.getElementById("local").innerText = JSON.stringify(
          sm.log,
          null,
          2
        );

        // revlist cards

        toast.setAttribute("data-time", cfg.time || 0);
        let fragment = new DocumentFragment();
        for (var key in revlist) {
          let merge = revlist[key];
          let card = document.createElement("section");
          // style
          if (key == "c") {
            if (!server && key.hint != -1) {
              // DO NOT overwrite server or use status error
              sm.log[key] = merge;
            }
            card.style.backgroundColor = "#efefef";
          } else {
            let color = merge.color || (merge.c && merge.c.color) || "initial";
            card.style.backgroundColor = color;
            // legible text
            color = color.replace("#", "").replace("initial", "FFFFFF");
            color = +color.charAt(0) + +color.charAt(2) + +color.charAt(4);
            if (isFinite(color) && color <= 27) {
              card.style.color = "#fff";
            }
            let hint = 90 * (merge.c && merge.c.hint) || 0;
            hint = "hsl(" + hint + ", 100%, 50%)";
            card.style.boxShadow = "inset 0.25rem 0 " + hint;
          }
          // output
          let string = JSON.stringify({ [key]: merge }, null, 2);
          string = string.slice(1);
          string = string.slice(0, -1);
          card.innerText = string;

          fragment.append(card);
        }
        toast.appendChild(fragment);

        // revlist new add

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
          document.querySelector("#sessions.hide").classList.remove("hide");
        } else {
          sm.log[uid].e.unshift({
            time: Date.now(),
            value: "connect",
            id: 8080
          });
          sm.GET();
        }
      } else {
        switch (id) {
          case "gets":
            if (target.value > sm.gets) {
              sm[id]++;
            } else {
              target.value = sm.gets;
            }
            break;
          default:
            sm[id] = target.checked;
        }
      }
    }

    // vanity username...?
  },
  proxy_add: function (val, type) {
    if (type == "file") {
      var file = val.files[0];
      var reader = new FileReader();
      reader.onloadend = function () {
        console.log("FileReader:", reader.result);
        sm.proxy_add(reader.result);
      };
      reader.readAsDataURL(file);
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
