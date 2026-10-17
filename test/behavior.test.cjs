const test = require('node:test');
const assert = require('node:assert/strict');
const { Behavior } = require('../src/domain/behavior.cjs');
const programs = require('../src/shared/special-actions.js');
const idle = { state: 'idle', pending: 0, working: 0, last: null };
function fixture() {
  let now = 0;
  const pet = new Behavior(() => now, () => 0.3);
  return { pet, advance: ms => now += ms };
}
test('a meal plays fully before returning to the current task', () => {
  const { pet, advance } = fixture();
  pet.task({ ...idle, state:'working', working:1 });
  assert.equal(pet.interact('feed'),true);
  advance(3501);
  assert.equal(pet.snapshot().state,'feed');
  assert.equal(pet.interact('pat'),false);
  advance(6300);
  assert.equal(pet.snapshot().state,'working');
});
test('lion dance plays once, resumes the latest task and yields to approval', () => {
  const { pet, advance } = fixture();
  pet.task({ ...idle, state:'working', working:1 });
  assert.equal(pet.interact('lion'),true);
  advance(5000);
  pet.task({ ...idle, state:'thinking', working:1 });
  assert.equal(pet.snapshot().state,'lion');
  advance(5042);
  assert.equal(pet.snapshot().state,'thinking');
  pet.interact('lion');
  pet.task({ ...idle, state:'approval', pending:1 });
  assert.equal(pet.snapshot().state,'approval');
  assert.equal(pet.interact('lion'),false);
});
test('every extra program finishes once, preserves the latest task and respects approval', () => {
  for (const [id, clip] of Object.entries(programs)) {
    const { pet, advance } = fixture();
    assert.equal(pet.interact(id),true,id);
    advance(1000);
    pet.task({ ...idle,state:'working',working:1 });
    assert.equal(pet.snapshot().state,id);
    assert.equal(pet.interact('feed'),false);
    assert.equal(pet.interact('petCat'),false);
    advance(clip.duration-1001);
    assert.equal(pet.snapshot().state,id);
    advance(1);
    assert.equal(pet.snapshot().state,'working');
    assert.equal(pet.interact(id),true);
    pet.task({ ...idle,state:'approval',pending:1 });
    assert.equal(pet.snapshot().state,'approval');
    assert.equal(pet.interact(id),false);
  }
});
test('approval interrupts a meal; activity is restored after an expression', () => {
  const { pet, advance } = fixture();
  pet.interact('feed');
  pet.task({ ...idle,state:'approval',pending:1 });
  assert.equal(pet.snapshot().state,'approval');
  pet.task({ ...idle,state:'thinking',working:1 });
  pet.interact('happy');
  advance(4201);
  assert.equal(pet.snapshot().state,'thinking');
});
test('idle gets drowsy then sleeps and wakes on interaction', () => {
  const { pet, advance } = fixture();
  advance(31000); assert.equal(pet.snapshot().state,'drowsy');
  advance(15000); assert.equal(pet.snapshot().state,'sleep');
  pet.interact('pat'); assert.equal(pet.snapshot().state,'pat');
  advance(4201); assert.equal(pet.snapshot().state,'idle');
});
test('ambient expressions cannot postpone sleep forever', () => {
  const { pet, advance } = fixture();
  for (let i=0;i<46;i++) { advance(1000); pet.snapshot(); }
  assert.equal(pet.snapshot().state,'sleep');
});
test('completed reply eats a full meal then begins a fresh idle interval', () => {
  const { pet, advance } = fixture();
  advance(60000);
  pet.task({ ...idle,state:'completed' });
  advance(3501); assert.equal(pet.snapshot().state,'completed');
  advance(6300); assert.equal(pet.snapshot().state,'idle');
});
test('random interactions vary and rapid repeated touches get an angry reaction', () => {
  const { pet, advance } = fixture();
  pet.interact('touch'); const first=pet.snapshot().state;
  advance(2000); pet.interact('touch'); assert.notEqual(pet.snapshot().state,first);
  pet.interact('touch'); pet.interact('touch'); pet.interact('touch');
  assert.equal(pet.snapshot().state,'angry');
});
test('demo cycle never fabricates real tasks and a real event cancels it', () => {
  const { pet, advance } = fixture();
  pet.setCycle(true);
  assert.equal(pet.snapshot().demo,true);
  advance(5000); assert.equal(pet.snapshot().state,'thinking');
  pet.task({ ...idle,state:'approval',pending:1 });
  assert.equal(pet.snapshot().demo,false);
  assert.equal(pet.snapshot().state,'approval');
});
