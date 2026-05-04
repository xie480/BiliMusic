const axios = require('axios');
axios.get('https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
}).then(res => {
  const data = res.data.data;
  console.log('pages length:', data.pages ? data.pages.length : 0);
  if (data.pages && data.pages.length > 0) {
    console.log('first page:', data.pages[0]);
  }
}).catch(err => console.error(err.message));
