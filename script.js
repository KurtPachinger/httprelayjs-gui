sm = {
  proxy: "//demo.httprelay.io/proxy/" + uid,
  to: 5000,
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
      let log = JSON.parse(
        decodeURIComponent(ctx.request.url.searchParams.get("log"))
      );
      //console.log("log",log)

      // empty or malformed
      if (!log || !log.c.uid) {
        return {};
      }

      // branch to master, and users status
      let uid = sm.log[log.c.uid];
      let backup = sm.log.c.bak;
      let blocked = backup.indexOf(log.c.uid) !== -1;

      // sm.gets may increase but NOT decrease
      let is_full =
        sm.log.c.gets >= sm.gets && log.e[0] && log.e[0].value == "connect";

      if (uid == undefined || !log.e.length || is_full) {
        // new uid needs master branch
        // or uid blocked
        // or new user had no connect event
        let branch = { c: { uid: log.c.uid, hint: -1 }, e: [] };
        if (blocked || (uid == undefined && !log.e.length) || is_full) {
          // return error status to user (improper, blocked, full)
          console.log("user denied");
          return branch;
        } else if (uid == undefined && log.e.length) {
          // new master branch
          uid = sm.log[log.c.uid] = branch;
        }
      }

      // branch meta
      Object.keys(log.c).forEach((key) => {
        if (key != "uid") {
          uid.c[key] = log.c[key];
        }
      });
      if (log.c.uid != sm.log.c.uid) {
        // branch events
        for (let i = 0; i < log.e.length; i++) {
          //console.log("event", log.e[event]);
          uid.e.push(log.e[i]);
        }
      }

      // prune stable & users
      // audit sessions
      let revlist = {};
      let t = null,
        g = 0;
      Object.keys(sm.log).forEach((key) => {
        if (key != "c") {
          //console.log("master key", key);
          let user = sm.log[key];
          let u = (revlist[key] = { c: user.c });
          for (let i = user.e.length - 1; i >= 0; i--) {
            // user events
            let eventCurr = user.e[i];
            if (eventCurr.time < sm.log.c.time) {
              // time before head
              for (let j = i - 1; j >= 1; j--) {
                // prune events
                let eventPrev = user.e[j];
                let blacklist = eventCurr.type == "blacklist";
                if (
                  !blacklist &&
                  eventCurr.id == eventPrev.id &&
                  eventCurr.value == eventPrev.value
                ) {
                  user.e.splice(j, 1);
                  i--;
                }
              }
            }
            // time after head
            if (uid.c.hint == -1 || eventCurr.time >= sm.log.c.time) {
              if (log.c.uid != user.c.uid) {
                // commits to revlist, unless own user
                u[eventCurr.time] = eventCurr;
              }
            }
          }
          
          

          blocked = backup.indexOf(user.c.uid) !== -1;
          if (!blocked || sm.purge) {
            
            // users session criterion to reduce zombies
            const time = user.c.time;
            const is_server = sm.log.c.uid == user.c.uid;
            let active = !!(user.e.length > 1 || user.c.user);
            let recent = 60000 >= sm.log.c.time - user.e[0].time;
            const is_unload = time === null || (!active && !recent);

            if (!is_server && is_unload) {
              // prune users
              backup.push(user.c.uid);
              if (user.e.length <= 1 || sm.purge) {
                // prune _empty_ backlog
                delete sm.log[user.c.uid];
              }
            } else {
              // audit users
              g++;
              if (t == null || time < t) {
                t = time;
              }
            }
          }
          
        }
      });

      //
      // 4
      sm.log.c.time = t;
      sm.log.c.gets = g;

      //
      // 5-8
      let deltaUser = (Date.now() - uid.c.time) / g;
      uid.c.hint = Math.max(1 - deltaUser / sm.to, 0);

      revlist.c = sm.log.c;
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
  GET: function (unload, cfg) {
    // consume endpoint, push branch
    let branch = sm.log[uid];
    let last = branch.c.time || -Infinity;
    const time = Date.now();

    branch.c.time = time;
    if (unload) {
      branch.c.time = branch.e[time] = null;
    } else if (cfg && cfg.hint == -1) {
      last = -Infinity;
    }

    let params = { c: branch.c, e: [] };
    // filter user events by time
    for (let i = branch.e.length - 1; i >= 0; i--) {
      let event = branch.e[i];
      if (event.time <= last) {
        // events should not share timestamps
        break;
      }
      params.e.unshift(event);
    }

    params = encodeURIComponent(JSON.stringify(params));

    // route has 20-minute cache ( max 2048KB ~= 2MB )
    fetch(sm.proxy + "/log?log=" + params, {
      keepalive: true
    })
      .then((response) => {
        return response.text();
      })
      .then((data) => {
        return data ? JSON.parse(data) : {};
      })
      .then((remote) => {
        console.log("remote", remote);
        if (!remote || !remote.c) {
          // Error 406 Not Acceptable, empty response...
          //document.getElementById("client").disabled = false;
          console.log("no response");
          //return;
        } else if (remote.c.gets > 4) {
          console.log("max user");
        }

        // schedule GET
        let cfg = remote.c && remote.c.hint == -1 ? remote.c : null;
        clearTimeout(sm.sto);
        sm.sto = setTimeout(function () {
          sm.GET(unload, cfg);
        }, sm.to);

        // local logs
        document.getElementById("local").innerText = JSON.stringify(
          sm.log,
          null,
          2
        );

        // revlist cards
        let toast = document.createElement("article");
        toast.setAttribute("data-time", remote.c.time || 0);
        let fragment = new DocumentFragment();
        for (var key in remote) {
          let merge = remote[key];
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
            let hint = 90 * merge.c.hint;
            hint = "hsl(" + hint + ", 100%, 50%)";
            card.style.boxShadow = "inset 0.25rem 0 " + hint;
          }
          // output
          let string = JSON.stringify({ [key]: merge }, null, 2);
          string = string.slice(1);
          string = string.slice(0, -1);
          card.innerText = string;

          fragment.prepend(card);
        }
        toast.appendChild(fragment);

        // revlist new add
        let revlist = document.getElementById("revlist");
        revlist.appendChild(toast);
        toast.scrollIntoView();

        // revlist old remove
        let articles = revlist.getElementsByTagName("article");
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
