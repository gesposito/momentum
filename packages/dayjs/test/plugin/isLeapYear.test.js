import MockDate from 'mockdate'
import dayjs from 'dayjs'
import isLeapYear from 'dayjs/plugin/isLeapYear'

dayjs.extend(isLeapYear)

beforeEach(() => {
  MockDate.set(new Date())
})

afterEach(() => {
  MockDate.reset()
})

it('IsLeapYear', () => {
  expect(dayjs('20000101').isLeapYear()).toBe(true)
  expect(dayjs('2100-01-01').isLeapYear()).toBe(false)
})
