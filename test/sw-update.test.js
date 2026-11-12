// The page's side of a service-worker update (js/sw-update.js): when it asks
// the waiting worker to take over, and the wiring that decides whether a
// takeover is an update (GitHub #14: C1-C5). Fakes stand in for
// `navigator.serviceWorker`, a registration, a worker and the document.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP_WAITING_MESSAGE, createUpdateFlow, getHadController } from '../js/sw-update.js';

// ---- Fakes ----

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function fakeWorker(state = 'installed') {
  const worker = new FakeTarget();
  worker.state = state;
  worker.messages = [];
  worker.postMessage = (message) => worker.messages.push(message);
  return worker;
}

function fakeServiceWorker({ controller = null, registration, getRegistrationError } = {}) {
  const target = new FakeTarget();
  target.controller = controller;
  target.getRegistration = async () => {
    if (getRegistrationError) throw getRegistrationError;
    return registration;
  };
  return target;
}

function fakeRegistration({ waiting = null } = {}) {
  const registration = new FakeTarget();
  registration.waiting = waiting;
  registration.installing = null;
  return registration;
}

function setup({ serviceWorker, view = { isOnHome: true, hasOpenDialog: false, isUserTap: false } } = {}) {
  const doc = new FakeTarget();
  doc.visibilityState = 'visible';
  const state = { view: { ...view }, reloads: 0, idle: null };
  const flow = createUpdateFlow({
    serviceWorker,
    getView: () => state.view,
    reload: () => { state.reloads += 1; },
    document: doc,
    onIdle: (listener) => { state.idle = listener; }
  });
  return { flow, doc, state };
}

const CONTROLLER = {};

// ---- Tests ----

describe('getHadController', () => {
  it('is true with a controller, whatever the registration', async () => {
    assert.equal(await getHadController(fakeServiceWorker({ controller: CONTROLLER })), true);
  });

  it('is true for a hard-reloaded page: no controller but an active worker', async () => {
    assert.equal(await getHadController(fakeServiceWorker({ registration: { active: {} } })), true);
  });

  it('is false on a first visit, and during the first install (a registration that is only installing)', async () => {
    assert.equal(await getHadController(fakeServiceWorker()), false);
    assert.equal(await getHadController(fakeServiceWorker({ registration: { active: null, installing: {} } })), false);
  });

  it('is false, not a throw, when reading the registration fails', async () => {
    assert.equal(await getHadController(fakeServiceWorker({ getRegistrationError: new Error('blocked') })), false);
  });
});

describe('createUpdateFlow: start', () => {
  it('attaches the controllerchange listener before it awaits the registration', async () => {
    const serviceWorker = fakeServiceWorker({ controller: CONTROLLER });
    const { flow } = setup({ serviceWorker });
    const started = flow.start();
    assert.equal(serviceWorker.listeners.get('controllerchange').length, 1, 'listener is there while getRegistration is pending');
    await started;
  });

  it('survives getRegistration failing, and still attaches everything', async () => {
    const serviceWorker = fakeServiceWorker({ getRegistrationError: new Error('blocked') });
    const { flow, doc } = setup({ serviceWorker });
    await flow.start();
    assert.equal(serviceWorker.listeners.get('controllerchange').length, 1);
    assert.equal(doc.listeners.get('visibilitychange').length, 1);
  });

  it('reloads on a takeover of a page that had a controller', async () => {
    const serviceWorker = fakeServiceWorker({ controller: CONTROLLER });
    const { flow, state } = setup({ serviceWorker });
    await flow.start();
    serviceWorker.emit('controllerchange');
    assert.equal(state.reloads, 1);
  });

  it('does not reload on the takeover of a first install, even in a second tab or after a refresh', async () => {
    // No controller; a registration whose worker is still installing.
    const serviceWorker = fakeServiceWorker({ registration: { active: null, installing: {} } });
    const { flow, state } = setup({ serviceWorker });
    await flow.start();
    serviceWorker.emit('controllerchange');
    assert.equal(state.reloads, 0);
  });

  it('reloads a hard-reloaded page (active registration, no controller) at its takeover', async () => {
    const serviceWorker = fakeServiceWorker({ registration: { active: {} } });
    const { flow, state } = setup({ serviceWorker });
    await flow.start();
    serviceWorker.emit('controllerchange');
    assert.equal(state.reloads, 1);
  });
});

describe('createUpdateFlow: asking the waiting worker to take over', () => {
  async function started(options) {
    const serviceWorker = fakeServiceWorker({ controller: CONTROLLER });
    const ctx = setup({ serviceWorker, ...options });
    await ctx.flow.start();
    return { ...ctx, serviceWorker };
  }

  it('posts SKIP_WAITING at once for a worker already waiting, when home is showing', async () => {
    const { flow } = await started();
    const waiting = fakeWorker();
    flow.watch(fakeRegistration({ waiting }));
    assert.deepEqual(waiting.messages, [SKIP_WAITING_MESSAGE]);
    assert.deepEqual(SKIP_WAITING_MESSAGE, { type: 'SKIP_WAITING' });
  });

  it('waits during a round or with a sheet open, then asks on the next home mount (retry)', async () => {
    const { flow, state } = await started({ view: { isOnHome: false, hasOpenDialog: false, isUserTap: false } });
    const waiting = fakeWorker();
    flow.watch(fakeRegistration({ waiting }));
    assert.deepEqual(waiting.messages, []);
    state.view = { isOnHome: true, hasOpenDialog: true, isUserTap: false };
    flow.retry();
    assert.deepEqual(waiting.messages, [], 'a sheet is open');
    state.view = { isOnHome: true, hasOpenDialog: false, isUserTap: false };
    flow.retry();
    assert.deepEqual(waiting.messages, [SKIP_WAITING_MESSAGE]);
    flow.retry();
    assert.equal(waiting.messages.length, 1, 'asks once');
  });

  it('retries when the page becomes visible, when a sheet closes and when busy work settles', async () => {
    const { flow, doc, state } = await started({ view: { isOnHome: false, hasOpenDialog: false, isUserTap: false } });
    const waiting = fakeWorker();
    flow.watch(fakeRegistration({ waiting }));
    state.view = { isOnHome: true, hasOpenDialog: false, isUserTap: false };
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    assert.deepEqual(waiting.messages, [], 'hidden does not count');
    doc.visibilityState = 'visible';
    doc.emit('visibilitychange');
    assert.equal(waiting.messages.length, 1);

    const second = await started({ view: { isOnHome: false, hasOpenDialog: false, isUserTap: false } });
    const waiting2 = fakeWorker();
    second.flow.watch(fakeRegistration({ waiting: waiting2 }));
    second.state.view = { isOnHome: true, hasOpenDialog: false, isUserTap: false };
    second.doc.emit('close');
    assert.equal(waiting2.messages.length, 1);

    const third = await started({ view: { isOnHome: false, hasOpenDialog: false, isUserTap: false } });
    const waiting3 = fakeWorker();
    third.flow.watch(fakeRegistration({ waiting: waiting3 }));
    third.state.view = { isOnHome: true, hasOpenDialog: false, isUserTap: false };
    third.state.idle();
    assert.equal(waiting3.messages.length, 1);
  });

  it('follows a worker that finishes installing under a controlled page', async () => {
    const { flow } = await started();
    const registration = fakeRegistration();
    flow.watch(registration);
    const installing = fakeWorker('installing');
    registration.installing = installing;
    registration.emit('updatefound');
    installing.state = 'installed';
    installing.emit('statechange');
    assert.deepEqual(installing.messages, [SKIP_WAITING_MESSAGE]);
  });

  it('never asks during a first install (no controller yet)', async () => {
    const serviceWorker = fakeServiceWorker();
    const { flow } = setup({ serviceWorker });
    await flow.start();
    const registration = fakeRegistration();
    flow.watch(registration);
    const installing = fakeWorker('installing');
    registration.installing = installing;
    registration.emit('updatefound');
    installing.state = 'installed';
    installing.emit('statechange');
    assert.deepEqual(installing.messages, []);
  });

  it('holds back a reload that arrives mid-round and fires it when home is reached without a tap (C2)', async () => {
    const { flow, serviceWorker, state } = await started({ view: { isOnHome: false, hasOpenDialog: false, isUserTap: false } });
    serviceWorker.emit('controllerchange');
    assert.equal(state.reloads, 0);
    state.view = { isOnHome: true, hasOpenDialog: false, isUserTap: false };
    flow.retry();
    assert.equal(state.reloads, 1);
    flow.retry();
    assert.equal(state.reloads, 1, 'reloads once');
  });
});

describe('createUpdateFlow: input', () => {
  it('rejects bad options', () => {
    assert.throws(() => createUpdateFlow({ serviceWorker: fakeServiceWorker(), getView: null, reload: () => {} }), TypeError);
    assert.throws(() => createUpdateFlow({ serviceWorker: fakeServiceWorker(), getView: () => ({}), reload: null }), TypeError);
  });
});
