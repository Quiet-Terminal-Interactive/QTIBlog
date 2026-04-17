# ECS Explained: Why Clockwork Uses It (and Why You Should Care)

If you've ever built a game using inheritance-heavy OOP, you've probably ended up with something like:

```
GameObject -> Character -> Enemy -> FlyingEnemy -> BossEnemy -> FireBossEnemy
```

and somewhere along the way you realised that inheritance is just messy.

Clockwork doesn't do that.

Instead, it uses **ECS (Entity Component System)**, and not the "kind of ECS" that quietly turns back into OOP when nobody's looking.
Clockwork's version is strict, opinionated, and very intentional.

Let's break down what that means, and why it actually matters.

---

## The Core Idea

ECS splits your game into three things:

- **Entities**: just IDs (literally just "things that exist")
- **Components**: pure data
- **Systems**: all the behavior

That's it. No hidden magic. No inheritance chains.

---

## 1. Components Are Just Data

Clockwork draws a hard line here:

> Components are pure data. No methods. No logic.

```ts
// ✅ Good
interface Health {
  current: number
  max: number
}

// ❌ Not allowed
interface Health {
  current: number
  takeDamage(amount: number) { ... }
}
```

Why be this strict?

* Serialization is free (save/load just works)
* Modding is safer (data can't secretly execute logic)
* Separation of concerns is enforced, not "suggested"
* Performance unlocked - components stored in packed arrays (cache-friendly SoA layout)

You don't accidentally write messy architecture because you physically can't.

---

## 2. Systems Do All the Work

All behavior lives in systems:

```ts
function damageSystem(ctx: SystemContext) {
  const events = ctx.events.listen(DamageEvent)

  for (const event of events.iter()) {
    const healthStore = ctx.world.components.get(Health)
    const health = healthStore.get(event.target)
    if (health) {
      health.current -= event.amount
    }
  }
}
```

Systems:

* Query for entities with certain components
* Run logic over them
* Stay completely unaware of what the entity actually is

The system doesn't care if it's a player, enemy, or explosive barrel.
If it has `Health`, it can take damage.

That's the whole trick.

---

## 3. Entities Are Just Composition

An entity is basically a bag of components with an ID.

But here's the clever bit: Clockwork uses generational indices to prevent stale references.

```ts
Entity = { index: u32, generation: u32 } // packed to 64-bit
```

If you destroy entity #5 and reuse that slot, the generation counter increments. Old handles to "entity 5, gen 1" won't accidentally point at the new "entity 5, gen 2."

You get safe entity recycling without memory leaks or dangling pointers.

---

An enemy might look like:

```ts
Entity #42 (gen 1)
  + Transform
  + Physics
  + Health
  + AI
  + Sprite
```

A projectile?

```ts
Entity #87 (gen 1)
  + Transform
  + Physics
  + Damage
  + Lifetime
```

No inheritance or special cases.

---

## 4. Systems Run in Stages

Clockwork doesn't just run systems whenever. It uses a **stage-based pipeline**:

* Boot
* PreUpdate
* FixedUpdate (runs 0-N times per frame)
* Update
* LateUpdate
* RenderPrep
* Render
* PostRender
* Shutdown

Within each stage:

* Systems have an explicit order
* Systems declare what they read/write
* Execution is deterministic and predictable

Right now, execution is sequential, but the important part is this: The engine already knows enough to run systems in parallel later.

The dependency metadata isn't documentation—it's machine-readable data for a future parallel scheduler.

---

## 5. Events Are First-Class

Clockwork treats events as a core system, not a utility.

* Dedicated `EventBus`
* Typed channels (`Events<T>`)
* Buffered and immediate dispatch
* Auto-cleared between stages

Example flow:

* Physics system emits `CollisionEvent`
* Damage system listens and applies damage
* Audio system listens and plays a sound

No direct coupling. No system reaching into another system's internals.

Just clean, decoupled communication.

---

## 6. Determinism Is Built In

Clockwork leans toward determinism:

* Fixed timestep (default 1/60)
* Stable system order (explicit ordering)
* Stable entity iteration (sorted by EntityId)
* Seeded RNG (no `Math.random()` chaos)
* Max catch-up steps (default 5 - prevents spiral of death)

That last one is crucial: if your game hitches and accumulates 10 frames of simulation debt, Clockwork won't try to catch up all at once (which would cause another hitch). It caps it at 5 steps and accepts being slightly behind.

There's even a debug system that will warn you:

> "Hey. This system is being non-deterministic in FixedUpdate. That's suspicious."

Why this matters:

* Replays (same inputs = same outcome)
* Multiplayer (server + client stay in sync)
* Debugging (bugs are reproducible instead of mythical)

And if you want to go full hardcore:

* There's support for fixed-point math for cross-platform determinism

---

## A Real Example: Rogue Reunion

Let's walk a real flow.

### Player fires a projectile

1. Input System (PreUpdate)
   Detects input, emits event or sets state

2. Weapon System (Update)
   Spawns a new entity via command buffer:
   ```ts
   ctx.commands.spawn()
     .add(Transform2D, { x: playerX, y: playerY })
     .add(Physics, { velocity: { x: speed, y: 0 } })
     .add(Damage, { amount: 10 })
     .add(Lifetime, { remaining: 5.0 })
   ```

3. Physics System (FixedUpdate)
   Moves the projectile:
   ```ts
   const query = ctx.world.query<[Transform2D, Physics]>()
     .with(Transform2D, Physics)
   
   for (const [entity, transform, physics] of query.iter()) {
     transform.position.x += physics.velocity.x * ctx.deltaTime
     transform.position.y += physics.velocity.y * ctx.deltaTime
   }
   ```

4. Collision System (FixedUpdate)
   Detects overlap, emits `CollisionEvent`

5. Damage System (Update)
   Listens, applies damage to `Health`

6. Cleanup System (LateUpdate)
   Destroys entities via command buffer:
   ```ts
   const query = ctx.world.query<[Lifetime]>().with(Lifetime)
   
   for (const [entity, lifetime] of query.iter()) {
     lifetime.remaining -= ctx.deltaTime
     if (lifetime.remaining <= 0) {
       ctx.commands.destroy(entity)
     }
   }
   ```

7. Command buffer flushes at end of stage
   All queued spawns/destroys happen safely

8. Render System (Render)
   Draws everything with `Sprite + Transform`

No system knows about "projectiles" as a concept. They just process components.

---

## The Rules You Will Break (At First)

### ❌ Mutating the world during iteration

You will try this:

```ts
for (const [entity, health] of query.iter()) {
  if (health.current <= 0) {
    world.destroy(entity) // ❌ Iterator corruption!
  }
}
```

Don't.

Clockwork uses a `CommandBuffer` for a reason:

```ts
for (const [entity, health] of query.iter()) {
  if (health.current <= 0) {
    ctx.commands.destroy(entity) // ✅ Queued safely
  }
}
// Commands flush at end of stage
```

* Mutations are queued
* Applied safely later
* No iterator corruption

---

### ❌ Putting logic in components

This is muscle memory from OOP.

Clockwork will fight you on it. Let it win.

---

### ❌ Doing async work in FixedUpdate

`FixedUpdate` is for deterministic simulation.

If you `await` in there, your replay system quietly dies inside.

Async is allowed in `Update`, `RenderPrep`, and other stages—just not the deterministic ones.

---

## Why Clockwork Uses ECS

Short version: Because it enforces good architecture by design, not by discipline.

Longer version:

* Modular: systems don't depend on entity types
* Testable: run logic headless, no renderer required
* Deterministic: reproducible simulations
* Extensible: plugins can add systems without breaking others
* Mod-friendly: data-driven components are easy to extend
* Performant: strict data-only components enable cache-friendly storage

Or put more bluntly: It's a game engine that doesn't fight your architecture.

---

## Why You Should Care

Even if you've never used ECS before:

* You'll write less tangled code
* You'll stop fearing adding one more feature
* You'll actually be able to reason about your systems

And when your game grows?

You won't be refactoring a class hierarchy from 2019.

---

## Sidebar: Why Not Just Use Unity's ECS?

Unity DOTS:
- Tied to Unity editor
- Job system is powerful but complex
- C# with Burst compiler
- Desktop/console focused

Clockwork:
- Pure TypeScript, no editor required
- Runs in browsers (WebGL2) or Tauri desktop
- Designed for modding from day one
- Headless mode for servers/testing
- API-only: you build everything through code

Clockwork is the web-native, modding-first ECS engine.

---

## Final Thought

ECS isn't about performance (though it helps).

It's about clarity and control.

Clockwork just takes that idea and removes all the optional parts.

Which sounds restrictive, until you realise most of those "options" are what caused the mess in the first place.