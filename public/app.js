// Klädd – forside

// Gør toppen frostet, når man har scrollet lidt ned
const topbar = document.getElementById('topbar');
const opdaterTopbar = () => topbar.classList.toggle('er-scrollet', window.scrollY > 4);
window.addEventListener('scroll', opdaterTopbar, { passive: true });
opdaterTopbar();

// Fanebjælke: marker den valgte fane (siderne findes ikke endnu)
const faner = document.querySelectorAll('.fane');
faner.forEach((fane) => {
  fane.addEventListener('click', (e) => {
    e.preventDefault();
    faner.forEach((f) => f.removeAttribute('aria-current'));
    fane.setAttribute('aria-current', 'page');
  });
});
