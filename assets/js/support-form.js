// Progressive enhancement only. Validation and removal of anonymous contact
// fields are enforced by the Worker even when JavaScript is disabled.
const form = document.querySelector('form[name="support"]');
if (form) {
  const preference = form.elements.contact_preference;
  const fields = form.querySelector('[data-support-contact-fields]');
  const email = form.elements.email;
  const name = form.elements.name;
  const update = () => {
    const anonymous = preference.value === 'anonymous';
    fields.hidden = anonymous;
    email.disabled = anonymous;
    name.disabled = anonymous;
    email.required = !anonymous;
  };
  preference.addEventListener('change', update);
  window.addEventListener('pageshow', update);
  update();
}
