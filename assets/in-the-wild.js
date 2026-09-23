import { CartLinesUpdateEvent } from '@shopify/events';

/**
 * "In the wild" section — hotspot popups with variant selection and add to cart.
 *
 * Written as a custom element so the Theme Editor's section re-renders call
 * connectedCallback / disconnectedCallback automatically. All listeners are
 * delegated from the section root and removed through one AbortController,
 * so re-renders never stack duplicate listeners.
 *
 * Cart updates are announced with Horizon's standard CartLinesUpdateEvent,
 * which is what the header cart bubble and the cart drawer listen for.
 */

/**
 * @typedef {object} WildVariant
 * @property {number} id
 * @property {string[]} options
 * @property {boolean} available
 * @property {string} price - Already formatted with the store's money format.
 * @property {string | null} image
 */

/**
 * @typedef {object} AjaxCart
 * @property {number} item_count
 * @property {unknown[]} items
 */

const SELECT_OPEN_CLASS = 'is-active';

/**
 * Turns "Medium, M" into ['medium', 'm'].
 * @param {string | undefined} list
 * @returns {string[]}
 */
function parseList(list) {
  if (!list) return [];
  return list
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Money strings from Liquid can contain HTML entities (e.g. &euro;).
 * DOMParser decodes them without executing anything.
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  return new DOMParser().parseFromString(value, 'text/html').documentElement.textContent ?? value;
}

/**
 * @param {Array<{ id: number, quantity: number }>} items
 * @returns {Promise<void>}
 */
async function postCartAdd(items) {
  const response = await fetch(Theme.routes.cart_add_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ items }),
  });

  if (!response.ok) {
    /** @type {{ description?: string, message?: string }} */
    const body = await response.json().catch(() => ({}));
    throw new Error(body.description || body.message || `Add to cart failed: ${response.status}`);
  }
}

/** @returns {Promise<AjaxCart>} */
async function fetchCart() {
  const response = await fetch(`${Theme.routes.cart_url}.js`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Cart request failed: ${response.status}`);
  return /** @type {Promise<AjaxCart>} */ (response.json());
}

class InTheWild extends HTMLElement {
  /** @type {AbortController | null} */
  #controller = null;

  /** Parsed variant JSON, cached per popup so it's only parsed once. */
  /** @type {WeakMap<HTMLDialogElement, WildVariant[]>} */
  #variants = new WeakMap();

  connectedCallback() {
    this.#controller = new AbortController();
    const { signal } = this.#controller;

    this.addEventListener('click', this.#onClick, { signal });
    this.addEventListener('change', this.#onChange, { signal });
    this.addEventListener('keydown', this.#onKeydown, { signal });
    this.addEventListener('submit', this.#onSubmit, { signal });
    // "cancel" doesn't bubble; the capture phase still reaches the section root.
    this.addEventListener('cancel', this.#onCancel, { signal, capture: true });
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#controller = null;
  }

  /* ---------------------------------------------------------------- */
  /* Event handlers                                                    */
  /* ---------------------------------------------------------------- */

  /** @param {MouseEvent} event */
  #onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const openButton = target.closest('[data-wild-open]');
    if (openButton instanceof HTMLElement) {
      // event.detail is 0 for keyboard "clicks", so keyboard users keep normal focus.
      this.#openPopup(openButton.dataset.wildOpen, event.detail > 0);
      return;
    }

    // Close any open dropdown when clicking anywhere outside it.
    const clickedSelect = target.closest('[data-wild-select]');
    this.querySelectorAll('[data-wild-select]').forEach((select) => {
      if (select !== clickedSelect && select instanceof HTMLElement) this.#closeSelect(select);
    });

    if (target.closest('[data-wild-close]')) {
      target.closest('dialog')?.close();
      return;
    }

    // A click on the ::backdrop is reported on the <dialog> itself, outside its box.
    if (target instanceof HTMLDialogElement && target.matches('[data-wild-popup]')) {
      const rect = target.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) target.close();
      return;
    }

    const trigger = target.closest('[data-wild-select-trigger]');
    if (trigger && clickedSelect instanceof HTMLElement) {
      this.#isSelectOpen(clickedSelect) ? this.#closeSelect(clickedSelect) : this.#openSelect(clickedSelect);
      return;
    }

    const option = target.closest('[role="option"]');
    if (option instanceof HTMLElement && clickedSelect instanceof HTMLElement) {
      this.#chooseOption(clickedSelect, option);
    }
  };

  /** @param {Event} event */
  #onChange = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('.wild-color__input')) return;

    const dialog = target.closest('dialog');
    if (dialog) this.#update(dialog);
  };

  /** @param {KeyboardEvent} event */
  #onKeydown = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const select = target.closest('[data-wild-select]');
    if (!(select instanceof HTMLElement)) return;

    if (target.matches('[data-wild-select-trigger]')) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        this.#openSelect(select);
      }
      return;
    }

    if (!target.matches('[data-wild-select-list]')) return;

    const options = this.#getOptions(select);
    const activeIndex = options.findIndex((option) => option.classList.contains(SELECT_OPEN_CLASS));

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.#setActive(select, Math.min(activeIndex + 1, options.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.#setActive(select, Math.max(activeIndex - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        this.#setActive(select, 0);
        break;
      case 'End':
        event.preventDefault();
        this.#setActive(select, options.length - 1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const active = options[activeIndex];
        if (active) this.#chooseOption(select, active);
        break;
      }
      case 'Escape':
        // Stop the Escape from also closing the whole popup.
        event.preventDefault();
        event.stopPropagation();
        this.#closeSelect(select, true);
        break;
      case 'Tab':
        this.#closeSelect(select);
        break;
      default:
        break;
    }
  };

  /** @param {Event} event */
  #onCancel = (event) => {
    const dialog = event.target;
    if (!(dialog instanceof HTMLDialogElement)) return;

    // If a dropdown is open, Escape closes the dropdown first, not the popup.
    const openSelect = Array.from(dialog.querySelectorAll('[data-wild-select]')).find(
      (select) => select instanceof HTMLElement && this.#isSelectOpen(select)
    );
    if (openSelect instanceof HTMLElement) {
      event.preventDefault();
      this.#closeSelect(openSelect, true);
    }
  };

  /** @param {SubmitEvent} event */
  #onSubmit = (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-wild-form]')) return;
    event.preventDefault();

    const dialog = form.closest('dialog');
    if (dialog) this.#addToCart(dialog, form);
  };

  /* ---------------------------------------------------------------- */
  /* Popup                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * @param {string | undefined} id
   * @param {boolean} [fromPointer]
   */
  #openPopup(id, fromPointer = false) {
    if (!id) return;
    const dialog = this.querySelector(`#${CSS.escape(id)}`);
    if (!(dialog instanceof HTMLDialogElement) || dialog.open) return;

    this.#setMessage(dialog, '');
    dialog.showModal();
    // showModal() focuses the close button; after a mouse/tap that shows an
    // unwanted focus ring, so focus the dialog container instead.
    if (fromPointer) dialog.focus();
    this.#update(dialog);
  }

  /**
   * @param {HTMLDialogElement} dialog
   * @returns {WildVariant[]}
   */
  #getVariants(dialog) {
    const cached = this.#variants.get(dialog);
    if (cached) return cached;

    /** @type {WildVariant[]} */
    let variants = [];
    try {
      const script = dialog.querySelector('[data-wild-variants]');
      variants = JSON.parse(script?.textContent || '[]');
      variants.forEach((variant) => {
        variant.price = decodeEntities(variant.price);
      });
    } catch (error) {
      console.error('[in-the-wild] Could not read variant data:', error);
    }

    this.#variants.set(dialog, variants);
    return variants;
  }

  /**
   * Current selection per option position; null where nothing is chosen yet.
   * @param {HTMLDialogElement} dialog
   * @returns {Array<string | null>}
   */
  #getSelection(dialog) {
    const options = this.#getOptionElements(dialog);
    /** @type {Array<string | null>} */
    const selection = options.map(() => null);

    // Colors are displayed first, so DOM order can differ from the product's
    // option order. Each element's data-option-index is its real position.
    options.forEach((option) => {
      const position = Number(option.dataset.optionIndex);
      if (option.matches('[data-wild-select]')) {
        selection[position] = option.dataset.selected ?? null;
        return;
      }
      const checked = option.querySelector('input:checked');
      selection[position] = checked instanceof HTMLInputElement ? checked.value : null;
    });

    return selection;
  }

  /**
   * @param {HTMLDialogElement} dialog
   * @returns {HTMLElement[]}
   */
  #getOptionElements(dialog) {
    return Array.from(dialog.querySelectorAll('[data-wild-option]')).filter(
      /** @returns {option is HTMLElement} */ (option) => option instanceof HTMLElement
    );
  }

  /**
   * Finds the variant matching every chosen option, or null while incomplete.
   * @param {HTMLDialogElement} dialog
   * @returns {WildVariant | null}
   */
  #resolveVariant(dialog) {
    const variants = this.#getVariants(dialog);
    const selection = this.#getSelection(dialog);

    // Products without options: the single variant is always the answer.
    if (selection.length === 0) return variants[0] ?? null;
    if (selection.includes(null)) return null;

    return variants.find((variant) => variant.options.every((value, index) => value === selection[index])) ?? null;
  }

  /**
   * Syncs price, image, availability hints and the button with the selection.
   * @param {HTMLDialogElement} dialog
   */
  #update(dialog) {
    const variants = this.#getVariants(dialog);
    const selection = this.#getSelection(dialog);
    const variant = this.#resolveVariant(dialog);

    this.#markUnavailable(dialog, variants, selection);
    this.#setMessage(dialog, '');

    const idInput = dialog.querySelector('[data-wild-variant-id]');
    if (idInput instanceof HTMLInputElement) idInput.value = variant ? String(variant.id) : '';

    if (!variant) {
      this.#setButton(dialog, true);
      return;
    }

    const price = dialog.querySelector('[data-wild-price]');
    if (price) price.textContent = variant.price;

    const image = dialog.querySelector('.wild-popup__image');
    if (variant.image && image instanceof HTMLImageElement) {
      image.removeAttribute('srcset');
      image.src = variant.image;
    }

    this.#setButton(dialog, variant.available);
  }

  /**
   * Fades values that have no available variant when combined with the
   * other options already chosen.
   * @param {HTMLDialogElement} dialog
   * @param {WildVariant[]} variants
   * @param {Array<string | null>} selection
   */
  #markUnavailable(dialog, variants, selection) {
    this.#getOptionElements(dialog).forEach((option) => {
      const position = Number(option.dataset.optionIndex);
      option.querySelectorAll('[data-wild-value]').forEach((element) => {
        if (!(element instanceof HTMLElement)) return;
        const value = element.dataset.wildValue;

        const available = variants.some(
          (variant) =>
            variant.available &&
            variant.options[position] === value &&
            variant.options.every((optionValue, index) => {
              const chosen = selection[index];
              return index === position || chosen === null || chosen === optionValue;
            })
        );

        element.toggleAttribute('data-unavailable', !available);
        if (element.getAttribute('role') === 'option') {
          element.setAttribute('aria-disabled', String(!available));
        }
      });
    });
  }

  /**
   * @param {HTMLDialogElement} dialog
   * @param {boolean} available
   */
  #setButton(dialog, available) {
    const button = dialog.querySelector('[data-wild-submit]');
    const label = dialog.querySelector('[data-wild-submit-label]');
    if (!(button instanceof HTMLButtonElement) || !label) return;

    // Stays enabled while options are missing, so the click can explain what's needed.
    button.disabled = !available;
    label.textContent = available ? this.dataset.atcText ?? '' : this.dataset.soldOutText ?? '';
  }

  /**
   * @param {HTMLDialogElement} dialog
   * @param {string} text
   */
  #setMessage(dialog, text) {
    const message = dialog.querySelector('[data-wild-message]');
    if (message) message.textContent = text;
  }

  /* ---------------------------------------------------------------- */
  /* Dropdown (custom listbox)                                         */
  /* ---------------------------------------------------------------- */

  /**
   * @param {HTMLElement} select
   * @returns {HTMLElement[]}
   */
  #getOptions(select) {
    return Array.from(select.querySelectorAll('[role="option"]')).filter(
      /** @returns {option is HTMLElement} */ (option) => option instanceof HTMLElement
    );
  }

  /** @param {HTMLElement} select */
  #isSelectOpen(select) {
    const list = select.querySelector('[data-wild-select-list]');
    return list instanceof HTMLElement && !list.hidden;
  }

  /** @param {HTMLElement} select */
  #openSelect(select) {
    const trigger = select.querySelector('[data-wild-select-trigger]');
    const list = select.querySelector('[data-wild-select-list]');
    if (!(trigger instanceof HTMLElement) || !(list instanceof HTMLElement)) return;

    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');

    const options = this.#getOptions(select);
    const selectedIndex = options.findIndex((option) => option.getAttribute('aria-selected') === 'true');
    this.#setActive(select, Math.max(selectedIndex, 0));
    list.focus();
  }

  /**
   * @param {HTMLElement} select
   * @param {boolean} [returnFocus]
   */
  #closeSelect(select, returnFocus = false) {
    const trigger = select.querySelector('[data-wild-select-trigger]');
    const list = select.querySelector('[data-wild-select-list]');
    if (!(trigger instanceof HTMLElement) || !(list instanceof HTMLElement) || list.hidden) return;

    list.hidden = true;
    list.removeAttribute('aria-activedescendant');
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus();
  }

  /**
   * @param {HTMLElement} select
   * @param {number} index
   */
  #setActive(select, index) {
    const list = select.querySelector('[data-wild-select-list]');
    const options = this.#getOptions(select);
    const active = options[index];
    if (!list || !active) return;

    options.forEach((option) => option.classList.toggle(SELECT_OPEN_CLASS, option === active));
    list.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }

  /**
   * @param {HTMLElement} select
   * @param {HTMLElement} option
   */
  #chooseOption(select, option) {
    const value = option.dataset.wildValue;
    const display = select.querySelector('[data-wild-select-value]');
    if (!value || !display) return;

    select.dataset.selected = value;
    this.#getOptions(select).forEach((item) => item.setAttribute('aria-selected', String(item === option)));
    display.textContent = value;
    display.classList.remove('is-placeholder');

    this.#closeSelect(select, true);

    const dialog = select.closest('dialog');
    if (dialog) this.#update(dialog);
  }

  /* ---------------------------------------------------------------- */
  /* Add to cart                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Returns the bonus variant id when the chosen variant has one value from
   * each trigger list (e.g. "Black" + "Medium"), otherwise null.
   * @param {WildVariant} variant
   * @param {string | undefined} productId
   * @returns {number | null}
   */
  #getBonusVariantId(variant, productId) {
    const bonusId = Number(this.dataset.bonusVariantId);
    if (!bonusId || productId === this.dataset.bonusProductId) return null;

    const values = variant.options.map((value) => value.toLowerCase());
    const groupA = parseList(this.dataset.triggerA);
    const groupB = parseList(this.dataset.triggerB);
    if (groupA.length === 0 || groupB.length === 0) return null;

    const matches = values.some((value) => groupA.includes(value)) && values.some((value) => groupB.includes(value));
    return matches ? bonusId : null;
  }

  /**
   * @param {HTMLDialogElement} dialog
   * @param {HTMLFormElement} form
   */
  async #addToCart(dialog, form) {
    const button = dialog.querySelector('[data-wild-submit]');
    if (!(button instanceof HTMLButtonElement) || button.getAttribute('aria-busy') === 'true') return;

    const variant = this.#resolveVariant(dialog);

    if (!variant) {
      // Ask for the first unanswered option in the order it appears on screen.
      const selection = this.#getSelection(dialog);
      const optionEl = this.#getOptionElements(dialog).find(
        (option) => selection[Number(option.dataset.optionIndex)] === null
      );
      const name = optionEl?.dataset.optionName ?? '';
      this.#setMessage(dialog, `${this.dataset.missingText ?? ''} ${name.toLowerCase()}`.trim());
      return;
    }

    if (!variant.available) return;

    const lines = [{ id: variant.id, quantity: 1 }];
    const bonusId = this.#getBonusVariantId(variant, dialog.dataset.productId);
    if (bonusId) lines.push({ id: bonusId, quantity: 1 });

    button.setAttribute('aria-busy', 'true');
    this.#setMessage(dialog, '');

    // Announce the add up front, like Horizon's own product form does; the cart
    // bubble and drawer wait on this promise and update when it resolves.
    const deferred = CartLinesUpdateEvent.createPromise();
    form.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'dialog',
        lines: lines.map((line) => ({ merchandiseId: String(line.id), quantity: line.quantity })),
        promise: deferred.promise,
      })
    );

    let didError = false;

    try {
      await postCartAdd([{ id: variant.id, quantity: 1 }]);
    } catch (error) {
      didError = true;
      console.error('[in-the-wild] Add to cart failed:', error);
      this.#setMessage(dialog, error instanceof Error && error.message ? error.message : this.dataset.errorText ?? '');
    }

    // Added separately so a sold-out bonus product can never block the main product.
    if (!didError && bonusId) {
      try {
        await postCartAdd([{ id: bonusId, quantity: 1 }]);
      } catch (error) {
        console.warn('[in-the-wild] Bonus product could not be added:', error);
      }
    }

    try {
      const cart = await fetchCart();
      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(/** @type {any} */ (cart)),
        detail: {
          items: cart.items,
          source: 'in-the-wild',
          itemCount: lines.length,
          productId: dialog.dataset.productId,
          didError,
        },
      });
    } catch (error) {
      deferred.reject(error);
      if (!didError) this.#setMessage(dialog, this.dataset.errorText ?? '');
    } finally {
      button.removeAttribute('aria-busy');
    }

    // Closing hands focus back and lets Horizon's cart drawer open (it waits for modals to close).
    if (!didError) dialog.close();
  }
}

if (!customElements.get('in-the-wild')) {
  customElements.define('in-the-wild', InTheWild);
}