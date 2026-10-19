import MockDate from 'mockdate'
import dayjs from 'dayjs'
import isMoment from 'dayjs/plugin/isMoment'

dayjs.extend(isMoment)

beforeEach(() => {
  MockDate.set(new Date())
})

afterEach(() => {
  MockDate.reset()
})

it('IsLeapYear', () => {
  expect(dayjs.isMoment(dayjs())).toBe(true)
  expect(dayjs.isMoment(new Date())).toBe(false)
})
