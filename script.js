sm = {
  proxy: "//demo.httprelay.io/proxy/" + uid,
  to: 2500,
  users: 2,
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

      // globals
      const uid = log.c.uid;
      let branch = sm.log[uid];
      let cfg = sm.log.c;
      cfg.time = Date.now();
      const blocked = cfg.bak.indexOf(uid) !== -1;

      // users may only increase
      let connect = log.e.length && log.e[0].value == "connect";
      let is_full = connect && cfg.users >= sm.users;

      if (is_full || branch === undefined || !log.e.length) {
        // uid needs master branch
        // or uid blocked
        // or uid connect event fail
        let revlist = { c: { uid: uid, hint: -1 }, e: [] };
        if (is_full || blocked || (branch === undefined && !log.e.length)) {
          // return error to user
          if (is_full) {
            revlist.c.time = "-Infinity";
          }
          return revlist;
        } else if (branch === undefined && log.e.length) {
          // new master branch, bump connect timestamp
          branch = sm.log[uid] = revlist;
        }
      }

      // push branch meta to master
      Object.keys(log.c).forEach((cfg) => {
        if (cfg !== "uid") {
          branch.c[cfg] = log.c[cfg];
        }
      });
      // push branch events to master
      if (uid !== cfg.uid) {
        for (let i = 0; i < log.e.length; i++) {
          branch.e.push(log.e[i]);
        }
      }

      // events: prune server old, sent client new
      let revlist = { c: { time: cfg.time } };
      let users = 0;
      Object.keys(sm.log).forEach((key) => {
        if (key !== "c") {
          //console.log("master key", key);
          let user = sm.log[key];
          let u = (revlist[key] = { c: user.c });
          let block = cfg.bak.indexOf(user.c.uid) !== -1;
          for (let i = user.e.length - 1; i >= 0; i--) {
            let event = user.e[i];

            // prune before head
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
              let HEAD = (tip_push || tip_pull) && event.time <= log.c.time;
              if ((HEAD && !block) || connect) {
                u[event.time] = event;
              }
            }
          }

          // user access control permission
          if (!block || sm.purge) {
            const is_server = cfg.uid == user.c.uid;
            let active = !!(user.e.length > 1 || user.c.user);
            let recent = 120000 >= cfg.time - user.e[0].time;
            const is_unload = user.c.time == Infinity || (!active && !recent);
            // prune users
            if (!is_server && is_unload) {
              !block && cfg.bak.push(user.c.uid);
              if (user.e.length <= 1 || sm.purge) {
                delete sm.log[user.c.uid];
              }
            } else {
              users++;
            }
          }
        }
      });

      // active sessions
      cfg.users = users;
      // timestamp log to master branch
      branch.c.time = log.c.time;
      // user latency
      let deltaUser = (cfg.time - branch.c.time) / users;
      deltaUser = Math.max(1 - deltaUser / sm.to, 0);
      branch.c.hint = deltaUser;
      // note: timestamp of server as client is more current than updates

      return revlist;
    });

    proxy.assets.addFetch("//codepen.io/kpachinger/pen/VwzmKJV.html", {
      name: "page",
      interpolate: true,
      mount: true
    });

    proxy.start();
  },
  GET: function (cfg = {}) {
    // consume endpoint, push branch
    let branch = sm.log[uid];
    let last = branch.c.time || -Infinity;
    const time = Date.now();

    switch (cfg.hint) {
      case -1:
        // critical event, bump connect timestamp
        branch.c.time = "-Infinity";
        branch.e[0].time = time;
        break;
      case Infinity:
        branch.c.time = "Infinity";
        break;
      default:
        branch.c.time = time;
    }
    branch.c.hint = 0;

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
          let err = "access error";
          if (cfg && cfg.time == -Infinity) {
            err += ": users max";
          } else if (cfg.hint !== -1 && cfg !== null) {
            // error fatal, but intended
            toast.innerText = err + ": expired";
            return;
          }
          toast.innerText = err;
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
          if (key == "c") {
            if (!server && key.hint != -1) {
              // pull revlist unless server or error
              sm.log[key] = merge;
            }
            card.style.backgroundColor = "#efefef";
          } else {
            // user style
            let color = merge.color || (merge.c && merge.c.color) || "initial";
            card.style.backgroundColor = color;
            // text legible
            color = color.replace("#", "").replace("initial", "FFFFFF");
            color = +color.charAt(0) + +color.charAt(2) + +color.charAt(4);
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
        }
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
          document.querySelector("#sessions.hide").classList.remove("hide");
        } else {
          let user = sm.log[uid];
          function rand(arr){
            return arr[Math.floor(Math.random() * arr.length)];
          }
          if(!user.c.name){
            let username = ["Delta", "Gamma", "Vega", "Theta"];
            username = rand(username);
            username += "_" + Math.floor(Math.random()*100);
            user.c.name = username;
          }
          if(!user.c.color){
            let color = ["c0", "cf", "ff"];
            color = "#" + rand(color) + rand(color) + rand(color);
            user.c.color = server ? "#c0c0c0" : color;
          }
          
          user.e.unshift({
            time: Date.now(),
            value: "connect",
            id: 8080
          });
          sm.GET();
        }
      } else {
        switch (id) {
          case "users":
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
