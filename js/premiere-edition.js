(function(){
  "use strict";

  function setBrand(){
    var title=document.querySelector(".orbit-header-copy strong");
    var tag=document.querySelector(".orbit-header-copy em");
    if(title) title.textContent="Orbit Premiere";
    if(tag) tag.textContent="Pro Studio Suite";
    document.title="CompX Orbit Studio – Premiere";

    var gateTitle=document.getElementById("cx-gate-title");
    var gateSub=document.querySelector(".cx-gate__sub");
    if(gateTitle) gateTitle.textContent="CompX Orbit for Premiere Pro";
    if(gateSub) gateSub.textContent="Pro Studio Suite";
  }

  function configureLibrary(){
    var row=document.getElementById("assetTypeRow");
    if(!row) return;

    // Must match the views map in modules/rail-router.js, which is the single
    // source of truth for which shelves exist.
    var allowedTypes = ["library", "silence", "captions", "beat", "audio", "motion", "doctor"];
    Array.prototype.forEach.call(row.querySelectorAll(".shelf"), function(btn){
      var t=btn.getAttribute("data-type");
      btn.style.display=(allowedTypes.indexOf(t) !== -1) ? "" : "none";
    });

    var active=row.querySelector(".shelf.active");
    var valid=active && allowedTypes.indexOf(active.getAttribute("data-type") || "") !== -1;
    if(!valid){
      var target=row.querySelector('.shelf[data-type="library"]');
      if(target) setTimeout(function(){ target.click(); }, 50);
    }
  }

  function init(){
    setBrand();
    configureLibrary();
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
