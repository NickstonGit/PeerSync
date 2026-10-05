import { describe, expect, it } from 'vitest'
import { RequestAdmissionGate } from './request-admission'

describe('RequestAdmissionGate', () => {
  it('admits up to the limit and refuses the next one without admitting it', () => {
    const gate = new RequestAdmissionGate(3)

    expect([gate.tryEnter(), gate.tryEnter(), gate.tryEnter()]).toEqual([true, true, true])
    expect(gate.count).toBe(3)
    expect(gate.saturated).toBe(true)

    expect(gate.tryEnter()).toBe(false)
    // A refused request must not consume a slot.
    expect(gate.count).toBe(3)
  })

  it('frees a slot again when an admitted request leaves', () => {
    const gate = new RequestAdmissionGate(1)

    expect(gate.tryEnter()).toBe(true)
    expect(gate.tryEnter()).toBe(false)
    gate.leave()
    expect(gate.count).toBe(0)
    expect(gate.saturated).toBe(false)
    expect(gate.tryEnter()).toBe(true)
  })

  it('never counts below zero when released more often than admitted', () => {
    const gate = new RequestAdmissionGate(2)

    gate.leave()
    gate.leave()
    gate.leave()

    expect(gate.count).toBe(0)
    expect(gate.tryEnter()).toBe(true)
    expect(gate.count).toBe(1)
  })

  it('resolves the drain barrier only after the last admitted request leaves', async () => {
    const gate = new RequestAdmissionGate(4)
    gate.tryEnter()
    gate.tryEnter()

    let drained = false
    const drain = gate.waitForDrain().then(() => {
      drained = true
    })

    gate.leave()
    await Promise.resolve()
    expect(drained).toBe(false)

    gate.leave()
    await drain
    expect(drained).toBe(true)
  })

  it('resolves the drain barrier immediately when nothing is admitted', async () => {
    const gate = new RequestAdmissionGate(4)

    await expect(gate.waitForDrain()).resolves.toBeUndefined()
  })

  it('refuses a non-positive limit instead of admitting nothing forever', () => {
    expect(() => new RequestAdmissionGate(0)).toThrow(RangeError)
    expect(() => new RequestAdmissionGate(-1)).toThrow(RangeError)
    expect(() => new RequestAdmissionGate(1.5)).toThrow(RangeError)
  })
})