import { env } from '@/env'
import { Chat, ChatMessage, ChatType } from '@/model/chat'
import { Conversation } from '@/model/conversation'
import { Farmer } from '@/model/farmer'
import { i18n } from '@/model/i18n'
import { ItemType } from '@/model/item'
import { LeekWars } from '@/model/leekwars'
import { Notification, NotificationType } from '@/model/notification'
import { Team } from '@/model/team'
import Vue from 'vue'
import Vuex, { Store } from 'vuex'
import { AI } from './ai'
import { fileSystem } from './filesystem'
import { Leek } from './leek'
import { vueMain } from './vue'
import { Weapon } from './weapon'

class LeekWarsState {
	public token: string | null = null
	public connected: boolean = false
	public farmer: Farmer | null = null
	public chat: {[key: string]: Chat} = {}
	public wsconnected: boolean = false
	public wsdisconnected: boolean = false
	public supertoken: string = ''
	public unreadMessages: number = 0
	public unreadNotifications: number = 0
	public notifications: Notification[] = []
	public conversations: {[key: number]: Conversation} = {}
	public conversationsList: Conversation[] = []
	public last_ping: number = 0
	public connected_farmers: number = 0
	public loadingConversations: boolean = false
	public habs_timer: any = null
	public crystals_timer: any = null
}

function updateTitle(state: LeekWarsState) {
	LeekWars.setTitleCounter(state.unreadNotifications + state.unreadMessages)
}
function loadNotifications(state: LeekWarsState) {
	LeekWars.get('notification/get-latest/20').then(data => {
		state.unreadNotifications = data.unread
		updateTitle(state)
		for (const notification of data.notifications.reverse()) {
			store.commit('notification', notification)
		}
	})
}
function loadMessages(state: LeekWarsState) {
	state.loadingConversations = true
	LeekWars.get('message/get-latest-conversations/25').then(data => {
		state.unreadMessages = data.unread
		updateTitle(state)
		for (const conversation of data.conversations) {
			store.commit('new-conversation', conversation)
		}
		state.loadingConversations = false
	})
}

Vue.use(Vuex)
const store: Store<LeekWarsState> = new Vuex.Store({
	state: new LeekWarsState(),
	getters: {
		moderator: (state: LeekWarsState) => state.farmer && state.farmer.moderator,
		admin: (state: LeekWarsState) => state.farmer && state.farmer.admin,
	},
	mutations: {
		"connected"(state: LeekWarsState, token: string) {
			state.connected = true
			state.token = token
		},
		"connect"(state: LeekWarsState, data: {farmer: Farmer, farmers: number, token: string}) {
			state.farmer = data.farmer
			Vue.set(state.farmer, 'animated_habs', state.farmer.habs)
			Vue.set(state.farmer, 'animated_crystals', state.farmer.crystals)
			state.token = data.token
			state.connected = true
			state.connected_farmers = data.farmers
			localStorage.setItem('connected', 'true')
			localStorage.removeItem('login-attempt')
			if (LeekWars.DEV) {
				localStorage.setItem('token', data.token)
			}
			loadNotifications(state)
			loadMessages(state)
			vueMain.$emit('connected', state.farmer)
		},
		"disconnect"(state: LeekWarsState) {
			LeekWars.post('farmer/disconnect')
			state.connected = false
			localStorage.removeItem('connected')
			localStorage.removeItem('login-attempt')
			localStorage.removeItem('token')
			localStorage.removeItem('editor/tabs')
			localStorage.removeItem('garden/category') // On revient à la catégorie potager par défaut
			state.token = null
			state.farmer = null
			LeekWars.socket.disconnect()
			LeekWars.setTitleCounter(0)
			LeekWars.battleRoyale.leave()
			state.notifications = []
			state.conversations = {}
			state.conversationsList = []
			state.unreadMessages = 0
			state.unreadNotifications = 0
			state.chat = {}
			fileSystem.clear()
			console.clear()
		},
		"wsconnected"(state: LeekWarsState) {
			state.wsconnected = true
			state.wsdisconnected = false
			vueMain.$emit('wsconnected')
		},
		"wsclose"(state: LeekWarsState) {
			for (const chat in state.chat) {
				state.chat[chat].invalidated = true
			}
			state.wsconnected = false
			state.wsdisconnected = true
		},
		'clear-chat'(state: LeekWarsState, chat: number) {
			Vue.delete(state.chat, chat)
			Vue.set(state.chat, chat, new Chat(chat, ChatType.GLOBAL))
		},
		'chat-receive'(state: LeekWarsState, message: ChatMessage) {
			if (!state.chat[message.chat]) {
				Vue.set(state.chat, message.chat, new Chat(message.chat, ChatType.GLOBAL))
			}
			state.chat[message.chat].add(message)
			vueMain.$emit('chat', [message.chat])
		},
		'chat-receive-pack'(state: LeekWarsState, pack: any) {
			if (!pack.length) { return }
			const channel = pack[0][0]
			if (!state.chat[channel]) {
				Vue.set(state.chat, channel, new Chat(channel, ChatType.GLOBAL))
			}
			state.chat[channel].set_messages(pack)
			vueMain.$emit('chat', [channel])
		},
		'br'(state: LeekWarsState, data: any) {
			const channel = data[0]
			if (!state.chat[channel]) {
				Vue.set(state.chat, channel, new Chat(channel, ChatType.GLOBAL))
			}
			state.chat[channel].battleRoyale(data[1], data[2])
		},
		'pm-receive'(state: LeekWarsState, data: any) {
			const conversationID = data.id
			const senderID = data.message[1]
			const senderName = data.message[2]
			const isNewMessage = !data.message[7] // Date (sent by chat component, not WS)
			const senderAvatar = data.message[6]

			// Get or create conversation
			let conversation = state.conversations[conversationID]
			if (!conversation) {
				conversation = {id: conversationID,	farmers: [], unread: false} as any
				Vue.set(state.conversations, conversationID, conversation)
				state.conversationsList.unshift(conversation)
			} else if (isNewMessage) {
				const index = state.conversationsList.findIndex((c) => c.id === conversationID)
				state.conversationsList.splice(index, 1)
				state.conversationsList.unshift(conversation)
				if (!conversation.unread && senderID !== state.farmer!.id) {
					conversation.unread = true
					state.unreadMessages++
					updateTitle(state)
				}
			}
			conversation.last_message = data.message[3]
			conversation.last_farmer_id = senderID
			conversation.last_farmer_name = senderName
			if (!conversation.farmers.find(f => f.id === senderID)) {
				conversation.farmers.push({id: senderID, name: senderName, avatar_changed: data.message[6]} as Farmer)
			}

			// Update or create chat
			if (!state.chat[conversationID]) {
				Vue.set(state.chat, conversationID, new Chat(conversationID, ChatType.PM, conversation))
			}
			state.chat[conversationID].add(data.message)
			vueMain.$emit('chat', [conversationID])

			// Square
			if (isNewMessage && conversation.last_farmer_id !== state.farmer!.id) {
				LeekWars.squares.addFromConversation(conversation, senderAvatar)
			}
		},
		'add-conversation-participant'(state: LeekWarsState, data: {id: number, farmer: Farmer}) {
			const conversation = state.conversations[data.id]
			if (conversation && !conversation.farmers.find(f => f.id === data.farmer.id)) {
				conversation.farmers.push(data.farmer)
			}
		},
		'update-crystals'(state: LeekWarsState, crystals: number) {
			if (state.farmer) {
				state.farmer.crystals += crystals
				clearTimeout(state.crystals_timer)
				const increment = (state.farmer!.crystals - state.farmer!.animated_crystals) / 23
				const update = () => {
					state.farmer!.animated_crystals = state.farmer!.animated_crystals + increment
					if (Math.abs(state.farmer!.animated_crystals - state.farmer!.crystals) > 0.4) {
						state.crystals_timer = setTimeout(update, 41)
					} else {
						state.farmer!.animated_crystals = state.farmer!.crystals
					}
				}
				update()
			}
		},
		'set-habs'(state: LeekWarsState, habs: number) {
			if (state.farmer) {
				state.farmer.habs = habs
			}
		},
		'update-habs'(state: LeekWarsState, habs: number) {
			if (state.farmer) {
				state.farmer.habs += habs
				clearTimeout(state.habs_timer)
				const increment = (state.farmer!.habs - state.farmer!.animated_habs) / 23
				const update = () => {
					state.farmer!.animated_habs = state.farmer!.animated_habs + increment
					if (Math.abs(state.farmer!.animated_habs - state.farmer!.habs) > 0.4) {
						state.habs_timer = setTimeout(update, 41)
					} else {
						state.farmer!.animated_habs = state.farmer!.habs
					}
				}
				update()
			}
		},
		'update-fights'(state: LeekWarsState, fights: number) {
			if (state.farmer) { state.farmer.fights += fights }
		},
		'set-talent'(state: LeekWarsState, talent: number) {
			if (state.farmer) { state.farmer.talent = talent }
		},
		'set-leek-talents'(state: LeekWarsState, talents: any) {
			if (state.farmer) {
				for (const i in talents) {
					state.farmer.leeks[parseInt(i, 10)].talent = talents[i]
				}
			}
		},
		'rename-leek'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				state.farmer.leeks[data.leek].name = data.name
			}
		},
		'rename-farmer'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				state.farmer.name = data.name
			}
		},
		'update-capital'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				state.farmer.leeks[data.leek].capital = data.capital
			}
		},
		'change-skin'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				state.farmer.leeks[data.leek].skin = data.skin
			}
		},
		'change-fish'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				state.farmer.leeks[data.leek].fish = data.fish
			}
		},
		'change-hat'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				const leek = state.farmer.leeks[data.leek]
				if (data.hat) {
					for (let h = 0; h < state.farmer.hats.length; ++h) {
						if (state.farmer.hats[h].hat_template === data.hat) {
							state.farmer.hats[h].quantity--
							if (state.farmer.hats[h].quantity === 0) {
								state.farmer.hats.splice(h, 1)
							}
							break
						}
					}
				}
				if (leek.hat) {
					const template = LeekWars.hats[LeekWars.hatTemplates[leek.hat].item]
					let found = false
					for (const hat of state.farmer.hats) {
						if (hat.template === template.id) {
							hat.quantity++
							found = true
							break
						}
					}
					if (!found) {
						const newHat = {
							template: LeekWars.hatTemplates[leek.hat].item,
							id: 0,
							name: template.name,
							level: template.level,
							hat_template: leek.hat,
							quantity: 1
						}
						state.farmer.hats.push(newHat)
					}
				}
				leek.hat = data.hat
			}
		},
		notification(state: LeekWarsState, data: any) {
			if (data.unread) {
				state.unreadNotifications = data.unread
				updateTitle(state)

				// Received a new trophy, invalidate farmer trophies, add to rewards
				if (state.farmer && data.type === NotificationType.TROPHY_UNLOCKED) {
					Vue.delete(state.farmer, 'trophies_list')
					const trophy = parseInt(data.parameters[0], 10)
					state.farmer.rewards.push({
						trophy,
						habs: LeekWars.trophies[trophy - 1].habs
					})
				}
			}
			const notification = Notification.build(data)
			state.notifications.unshift(notification)
			if (data.unread) {
				LeekWars.squares.addFromNotification(notification)
			}
		},
		'new-conversation'(state: LeekWarsState, data: any) {
			const conversation = state.conversations[data.id]
			if (!conversation) {
				Vue.set(state.conversations, data.id, data)
				state.conversationsList.push(data)
			} else {
				conversation.farmers.push(data.farmers[0])
			}
		},
		'quit-conversation'(state: LeekWarsState, id: number) {
			if (id in state.conversations) {
				Vue.delete(state.conversations, '' + id)
				const index = state.conversationsList.findIndex((conversation) => conversation.id === id)
				state.conversationsList.splice(index, 1)
			}
		},
		'unread-messages'(state: LeekWarsState, unread: number) {
			state.unreadMessages = unread
			updateTitle(state)
		},
		'read-notifications'(state: LeekWarsState) {
			state.unreadNotifications = 0
			for (const notification of state.notifications) {
				notification.read = true
			}
			updateTitle(state)
		},
		'read-notification'(state: LeekWarsState, id: number) {
			for (const notification of state.notifications) {
				if (notification.id === id) {
					notification.read = true
					break
				}
			}
		},
		'unread-notifications'(state: LeekWarsState, unread: number) {
			state.unreadNotifications = unread
			updateTitle(state)
		},
		'add-inventory'(state: LeekWarsState, data) {
			if (!state.farmer) { return }
			if (data.type === ItemType.WEAPON) {
				const weapon = LeekWars.selectWhere(state.farmer.weapons, 'id', data.item_id)
				if (weapon !== null) {
					weapon.quantity++
				} else {
					state.farmer.weapons.push({id: data.item_id, template: data.item_template, quantity: 1})
				}
			} else if (data.type === ItemType.CHIP) {
				const chip = LeekWars.selectWhere(state.farmer.chips, 'id', data.item_id)
				if (chip !== null) {
					chip.quantity++
				} else {
					state.farmer.chips.push({id: data.item_id, template: data.item_template, quantity: 1})
				}
			} else if (data.type === ItemType.HAT) {
				const hat = LeekWars.selectWhere(state.farmer.hats, 'id', data.item_id)
				const hat_template = LeekWars.getHatTemplate(data.item_template)
				if (hat !== null) {
					hat.quantity++
				} else {
					state.farmer.hats.push({id: data.item_id, template: data.item_template, name: LeekWars.hats[data.item_template].name, level: LeekWars.hats[data.item_template].level, hat_template, quantity: 1})
				}
			} else if (data.type === ItemType.POTION) {
				const potion = LeekWars.selectWhere(state.farmer.potions, 'id', data.item_id)
				if (potion !== null) {
					potion.quantity++
				} else {
					state.farmer.potions.push({id: data.item_id, template: data.item_template, quantity: 1})
				}
			} else if (data.type === ItemType.POMP) {
				state.farmer.pomps.push(data.item_template)
			}
		},
		'remove-inventory'(state: LeekWarsState, data) {
			if (!state.farmer) { return }
			console.log(data)
			if (data.type === ItemType.WEAPON) {
				const weapon = LeekWars.selectWhere(state.farmer.weapons, 'template', data.item_template)
				if (weapon !== null) {
					weapon.quantity--
				} else {
					LeekWars.removeOneWhere(state.farmer.weapons, 'template', data.item_template)
				}
			} else if (data.type === ItemType.CHIP) {
				const chip = LeekWars.selectWhere(state.farmer.chips, 'template', data.item_template)
				if (chip !== null) {
					chip.quantity--
				} else {
					LeekWars.removeOneWhere(state.farmer.chips, 'template', data.item_template)
				}
			} else if (data.type === ItemType.POTION) {
				const potion = LeekWars.selectWhere(state.farmer.potions, 'template', data.item_template)
				if (potion !== null) {
					potion.quantity--
				} else {
					LeekWars.removeOneWhere(state.farmer.potions, 'template', data.item_template)
				}
			}
		},
		'didactitiel-seen'(state: LeekWarsState) {
			if (state.farmer) { state.farmer.didactitiel_seen = true }
		},
		'add-weapon'(state: LeekWarsState, weapon) {
			if (!state.farmer) { return }
			for (const w of state.farmer.weapons) {
				if (w.template === weapon.template) {
					w.quantity++
					return
				}
			}
			state.farmer.weapons.push({id: weapon.id, quantity: 1, template: weapon.template})
		},
		'remove-weapon'(state: LeekWarsState, weapon: Weapon) {
			if (!state.farmer) { return }
			for (let w = 0; w < store.state.farmer!.weapons.length; ++w) {
				const f_weapon = store.state.farmer!.weapons[w]
				if (f_weapon.template === weapon.template) {
					f_weapon.quantity--
					if (f_weapon.quantity === 0) {
						state.farmer.weapons.splice(w, 1)
					}
					return
				}
			}
		},
		'add-chip'(state: LeekWarsState, chip) {
			if (!state.farmer) { return }
			for (const c of state.farmer.chips) {
				if (c.template === chip.template) {
					c.quantity++
					return
				}
			}
			state.farmer.chips.push({id: chip.id, quantity: 1, template: chip.template})
		},
		'remove-chip'(state: LeekWarsState, chip) {
			if (!state.farmer) { return }
			for (let w = 0; w < store.state.farmer!.chips.length; ++w) {
				const f_chip = store.state.farmer!.chips[w]
				if (f_chip.template === chip.template) {
					f_chip.quantity--
					if (f_chip.quantity === 0) {
						state.farmer.chips.splice(w, 1)
					}
					return
				}
			}
		},
		'last-connection'(state: LeekWarsState, time: number) {
			if (!state.farmer) { return }
			state.farmer.last_connection = time
		},
		'last-ping'(state: LeekWarsState, time: number) {
			state.last_ping = time
		},
		'receive-pong'(state: LeekWarsState, data: any) {
			const channel = data[0]
			if (!state.chat[channel]) {
				Vue.set(state.chat, channel, new Chat(channel, ChatType.GLOBAL))
			}
			// state.chat[channel].add(state.farmer!.id, state.farmer!.name, state.farmer!.avatar_changed, state.farmer!.grade, "pong ! " + (Date.now() - state.last_ping) + "ms", Date.now() / 1000)
			vueMain.$emit('chat', [channel])
		},
		'create-team'(state: LeekWarsState, team: Team) {
			if (state.farmer) {
				state.farmer.team = team
			}
		},
		'dissolve-team'(state: LeekWarsState) {
			if (state.farmer) {
				state.farmer.team = null
			}
		},
		'update-emblem'(state: LeekWarsState) {
			if (state.farmer && state.farmer.team) {
				state.farmer.team.emblem_changed = Date.now() / 1000
			}
		},
		'level-up'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				state.farmer.leeks[data.leek].level = data.level
				state.farmer.leeks[data.leek].capital = data.capital
			}
		},
		'add-ai'(state: LeekWarsState, ai: AI) {
			if (state.farmer) {
				state.farmer.ais.push(ai)
			}
		},
		'delete-ai'(state: LeekWarsState, id: number) {
			if (state.farmer) {
				state.farmer.ais = state.farmer.ais.filter(ai => ai.id !== id)
			}
		},
		'set-title'(state: LeekWarsState, title: number[]) {
			if (state.farmer) {
				state.farmer.title = title
			}
		},
		'set-leek-title'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				const leek = state.farmer.leeks[data.leek]
				leek.title = data.title
			}
		},
		'set-leek-weapon'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				const leek = state.farmer.leeks[data.leek]
				leek.weapon = data.weapon
			}
		},
		'toggle-show-ai-lines'(state: LeekWarsState) {
			if (state.farmer) {
				state.farmer.show_ai_lines = !state.farmer.show_ai_lines
			}
		},
		'set-trophies'(state: LeekWarsState, trophies) {
			if (state.farmer) {
				Vue.set(state.farmer, 'trophies_list', trophies)
			}
		},
		'connected-count'(state: LeekWarsState, farmers) {
			state.connected_farmers = farmers
		},
		'new-leek'(state: LeekWarsState, leek: Leek) {
			if (state.farmer) {
				Vue.set(state.farmer.leeks, leek.id, leek)
			}
		},
		'load-conversations'(state: LeekWarsState) {
			state.loadingConversations = true
			LeekWars.get('message/get-conversations/' + state.conversationsList.length + '/25').then(data => {
				for (const conversation of data.conversations) {
					store.commit('new-conversation', conversation)
				}
				state.loadingConversations = false
			})
		},
		'remove-reward'(state: LeekWarsState, trophy: number) {
			if (state.farmer) {
				state.farmer.rewards = state.farmer.rewards.filter(r => r.trophy !== trophy)
			}
		},
		'remove-all-rewards'(state: LeekWarsState) {
			if (state.farmer) {
				state.farmer.rewards = []
			}
		},
		'update-xp'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				state.farmer.leeks[data.leek].xp += data.xp
			}
		},
		'update-leek-talent'(state: LeekWarsState, data: any) {
			if (state.farmer) {
				state.farmer.leeks[data.leek].talent += data.talent
			}
		},
		'update-farmer-talent'(state: LeekWarsState, talent: number) {
			if (state.farmer) {
				state.farmer.talent += talent
			}
		},
	},
})
export { store }
