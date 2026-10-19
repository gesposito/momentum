import dayjs from 'dayjs'
import advancedFormat from 'dayjs/plugin/advancedFormat'
import weekOfYear from 'dayjs/plugin/weekOfYear'
import 'dayjs/locale/zh'
import 'dayjs/locale/zh-cn'

dayjs.extend(advancedFormat).extend(weekOfYear)

const zh = dayjs().locale('zh')
const zhCN = dayjs().locale('zh-cn')

test('ordinal', () => {
  expect(zh.format('wo')).toEqual(`${zh.format('w')}周`)
})

test('Meridiem', () => {
  for (let i = 0; i <= 24; i += 1) {
    expect(zh.add(i, 'hour').format('A')).toBe(zhCN.add(i, 'hour').format('A'))
  }
})
