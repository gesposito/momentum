import MockDate from 'mockdate'
import dayjs from 'dayjs'
import isToday from 'dayjs/plugin/isToday'

dayjs.extend(isToday)

beforeEach(() => {
  MockDate.set(new Date())
})

afterEach(() => {
  MockDate.reset()
})

it('is today', () => {
  expect(dayjs(new Date()).isToday()).toBeTruthy()
  expect(dayjs('2017-01-01').isToday()).toBeFalsy()
})
