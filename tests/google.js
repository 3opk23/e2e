
const debug = require('debug')('dsc-e2e:tests:google')

exports.options = {
  retries: 1,
  clients: [
    {
      browser: 'chrome',
    },
    {
      browser: 'firefox',
    },
    {
      browser: 'edge',
    },
    {
      browser: 'safari',
    },
    {
      browser: 'ie',
    },
  ],
}

exports.test = ({ driver, step }) => {
  step('load google.com', async () => {
    debug('loading google')
    await driver.get('https://google.com')
    debug('loaded google')
  })
}
