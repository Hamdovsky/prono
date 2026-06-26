const crowdHackerService = require('../services/crowdHackerService')

console.log('Debugging crowdHackerService...')
console.log('1. Loading profile...')
crowdHackerService.loadProfile()
console.log('2. Profile loaded:', crowdHackerService.promosportBiasProfile ? 'Success' : 'Failed')