// Theme toggle + reading progress. Nothing else — the CSS does the work.
(function () {
  var root = document.documentElement;

  function current() {
    return root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  }

  var btn = document.querySelector('[data-theme-toggle]');
  var label = document.querySelector('[data-theme-label]');

  function paint() {
    if (label) label.textContent = current() === 'dark' ? 'Light' : 'Dark';
  }
  paint();

  if (btn) {
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
      paint();
    });
  }

  var bar = document.querySelector('[data-progress]');
  if (bar) {
    var tick = function () {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + '%';
    };
    document.addEventListener('scroll', tick, { passive: true });
    tick();
  }
})();
